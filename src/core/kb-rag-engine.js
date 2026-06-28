import { db, DEXIE_MIN_KEY, DEXIE_MAX_KEY } from "./db.js";
import { eventBus } from "./event-bus.js";
import { workerBridge } from "../workers/worker-bridge.js";
import { apiClient } from "./api-client.js";
import { normalizeVector } from "../utils/vector-math.js";
import { EVENTS } from '../core/events.js';
import { EMBEDDING_BATCH_SIZE } from "./rag-constants.js";
import { keyRotator } from "./key-rotator.js";
import { getProviderFormat } from "../utils/api-utils.js";

// RAG Engine for Knowledge Base
class KbRagEngine {
  constructor() {
    this.tokenBudget = 5000;
    this.chunkTargetTokens = 512;
    this.overlapRatio = 0.2;

    this.penaltyFactor = 0.0; // No time decay for KB
    this.similarityThreshold = 0.2;

    this.currentSessionId = null;
    this.oramaDimension = 768;
    this._writeLock = Promise.resolve();
    
    this._initPromiseSession = null;
    this._initPromise = null;

    eventBus.on(EVENTS.SESSION_LOADED, this.handleSessionLoaded.bind(this));
    eventBus.on(EVENTS.SETTINGS_CHANGED, (data) => {
      if (data.key === "all" || data.key === "memory") {
        this.loadSettings();
      }
    });
    eventBus.on(EVENTS.WORKER_RESTARTED, async () => {
      if (this.currentSessionId) {
        this._initPromiseSession = null;
        this._initPromise = null;
        try {
          await db.kb_orama_snapshots.where("sessionId").equals(this.currentSessionId).delete();
        } catch (e) {
          console.error("[KbRagEngine] Failed to delete snapshot on worker restart:", e);
        }
        this.initOramaIndex(this.currentSessionId).catch(console.error);
      }
    });

    eventBus.on(EVENTS.ORAMA_SYNC_KB_SNAPSHOT, async (data) => {
      const snapSessionId = data.sessionId;
      const buffer = data.buffer;
      if (snapSessionId && buffer) {
        try {
          await db.kb_orama_snapshots.put({
            sessionId: snapSessionId,
            buffer: buffer,
            updatedAt: Date.now()
          });
        } catch (e) {
          console.error("Failed to commit KB Orama snapshot", e);
        }
      }
    });
  }

  async _acquireWriteLock(operationFn) {
    const prevLock = this._writeLock || Promise.resolve();
    let resolveLock;
    this._writeLock = new Promise(resolve => resolveLock = resolve);
    
    try {
      await prevLock;
      return await operationFn();
    } finally {
      resolveLock();
    }
  }

  async handleSessionLoaded(sessionContext) {
    const sessionId = sessionContext.session.id;
    await this.loadSettings();
    try {
      await this.initOramaIndex(sessionId);
    } catch (err) {
      console.error("[KbRagEngine] Failed to init Orama index:", err);
    }
    await this.sanityCheckKB(sessionId);
  }

  async loadSettings() {
    try {
      const memorySettings = await db.settings.get("memory");
      if (memorySettings) {
        if (memorySettings.ragKbTokenBudget !== undefined) {
          this.tokenBudget = memorySettings.ragKbTokenBudget;
        }
      }
    } catch (e) {
      console.warn("[KbRagEngine] Failed to load RAG settings, using defaults", e);
    }
  }

  async _getExpertWorkerConfig(expert) {
    let baseUrl = "";
    let format = "";
    if (expert.providerId) {
      const provider = await db.providers.get(expert.providerId);
      if (provider) {
        baseUrl = provider.baseUrl;
        format = getProviderFormat(provider);
      }
    }

    let apiKey = "";
    try {
      apiKey = await keyRotator.getNextKey(expert.providerId);
    } catch (e) {
      console.warn('[KbRagEngine] KeyRotator failed:', e.message);
      throw e;
    }

    return { 
      model: expert.modelName, 
      baseUrl, 
      format,
      apiKey,
      taskType: expert.taskType,
      outputDimensionality: 768
    };
  }

  async initOramaIndex(sessionId) {
    if (this._initPromiseSession === sessionId && this._initPromise) {
      return this._initPromise;
    }
    
    this._initPromiseSession = sessionId;
    this._initPromise = this._doInitOramaIndex(sessionId).catch(err => {
      this._initPromise = null;
      throw err;
    });
    
    return this._initPromise;
  }

  async _ensureInit(sessionId) {
    if (this._initPromiseSession !== sessionId || !this._initPromise) {
      return this.initOramaIndex(sessionId);
    }
    return this._initPromise;
  }

  async _doInitOramaIndex(sessionId) {
    console.log("[KbRagEngine] Initializing Orama Vector Index for session:", sessionId);
    this.currentSessionId = sessionId;

    const expert = await db.experts.get("EMBED_PRIMARY");
    let dimension = 768; 
    
    if (expert) {
        const safeModelName = typeof expert.modelName === "string" ? expert.modelName : "";
        const matchingDoc = await db.kb_embeddings
          .where("sessionId")
          .equals(sessionId)
          .first();
          
        if (matchingDoc && matchingDoc.vector) {
          dimension = matchingDoc.vector.length;
        }
    }
    this.oramaDimension = dimension;

    const snapshotRecord = await db.kb_orama_snapshots.get(sessionId);
    let snapshotBuffer = null;
    let docs = [];

    if (snapshotRecord && snapshotRecord.buffer) {
      console.log("[KbRagEngine] Found Orama snapshot, attempting to load directly from memory buffer...");
      snapshotBuffer = snapshotRecord.buffer;
    }

    if (!snapshotBuffer) {
      console.log("[KbRagEngine] No snapshot found. Building from DB rows...");
      const allDocs = await db.kb_embeddings
        .where("sessionId")
        .equals(sessionId)
        .toArray();
      
      docs = allDocs.filter(d => d.vector && d.vector.length === dimension);
    }

    try {
      const res = await workerBridge.dispatch("INIT_KB_ORAMA", {
        sessionId,
        docs,
        dimension,
        snapshotBuffer
      });
      
      if (res && res.snapshotBuffer) {
        await db.kb_orama_snapshots.put({
          sessionId,
          buffer: res.snapshotBuffer,
          updatedAt: Date.now()
        });
      }
      console.log(`[KbRagEngine] Orama indexed / loaded via Worker.`);
    } catch (err) {
      if (err.message && err.message.includes("SNAPSHOT_FAILED")) {
        console.warn("[KbRagEngine] Snapshot load failed, rebuilding from Dexie...");
        const allDocs = await db.kb_embeddings.where("sessionId").equals(sessionId).toArray();
        docs = allDocs.filter(d => d.vector && d.vector.length === dimension);
        const res = await workerBridge.dispatch("INIT_KB_ORAMA", {
          sessionId,
          docs,
          dimension,
          snapshotBuffer: null
        });
        
        if (res && res.snapshotBuffer) {
          await db.kb_orama_snapshots.put({
            sessionId,
            buffer: res.snapshotBuffer,
            updatedAt: Date.now()
          });
        }
        console.log(`[KbRagEngine] Orama rebuilt via Worker after snapshot failure.`);
      } else {
        throw err;
      }
    }
  }

  async sanityCheckKB(sessionId) {
    return this._acquireWriteLock(async () => {
      try {
        const expert = await db.experts.get("EMBED_PRIMARY");
        if (!expert) return;

        const session = await db.game_sessions.get(sessionId);
        if (!session) return;

        const files = await db.kb_files.where("sessionId").equals(sessionId).toArray();
        if (files.length === 0) return;

        const embeddings = await db.kb_embeddings.where("sessionId").equals(sessionId).toArray();
        const embeddedDocIds = new Set(embeddings.map(e => e.docId));

        const pendingFiles = files.filter(f => !embeddedDocIds.has(f.id));

        if (pendingFiles.length === 0) return;

        console.log(`[KbRagEngine] Found ${pendingFiles.length} pending KB files. Chunking and embedding...`);

        eventBus.emit(EVENTS.RAG_KB_SYNC_START, { total: pendingFiles.length });

        for (let i = 0; i < pendingFiles.length; i++) {
          const file = pendingFiles[i];
          try {
            const result = await workerBridge.dispatch("CHUNK_KB_AND_EMBED", {
              text: file.content,
              docId: file.id,
              expertConfig: await this._getExpertWorkerConfig(expert),
              targetTokens: this.chunkTargetTokens,
              overlapRatio: this.overlapRatio
            });

            if (result && result.results) {
              const newDocs = result.results.map((res) => ({
                id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2),
                sessionId: sessionId,
                docId: file.id,
                model: expert.modelName,
                vector: normalizeVector(res.vector),
                text: res.chunkText,
                chunkIndex: res.chunkIndex,
                title: file.name
              }));

              if (newDocs.length === 0) continue;

              await db.kb_embeddings.bulkAdd(newDocs);

              await this._ensureInit(sessionId);
              try {
                let addResult = await workerBridge.dispatch("ADD_TO_KB_ORAMA", {
                  docs: newDocs,
                  dimension: this.oramaDimension,
                  sessionId
                });
                if (addResult && addResult.success === false && addResult.reason === "NOT_INITIALIZED") {
                  await this.initOramaIndex(sessionId);
                  await workerBridge.dispatch("ADD_TO_KB_ORAMA", {
                    docs: newDocs,
                    dimension: this.oramaDimension,
                    sessionId
                  });
                }
              } catch (err) {
                 console.warn("[KbRagEngine] Batch Orama API failure:", err);
              }
            }
          } catch (err) {
            console.error(`[KbRagEngine] Failed to process file ${file.name}:`, err);
          }
          
          eventBus.emit(EVENTS.RAG_KB_SYNC_PROGRESS, { current: i + 1, total: pendingFiles.length });
        }
        
        eventBus.emit(EVENTS.RAG_KB_SYNC_COMPLETE, { sessionId });
      } catch (err) {
        console.warn("[KbRagEngine] Sanity check failed:", err);
      }
    });
  }

  async retrieveRelevantMemories(sessionId, queryText, topK = 3, options = {}) {
    if (!queryText || !queryText.trim()) return [];

    try {
      await this._ensureInit(sessionId);

      const expert = await db.experts.get("EMBED_PRIMARY");
      if (!expert) return [];

      const res = await apiClient.callEmbedding(
        "EMBED_PRIMARY",
        [queryText],
        "RETRIEVAL_QUERY",
        { signal: options.signal }
      );
      
      if (!res.embeddings || !res.embeddings[0]) {
        throw new Error("Invalid or empty response from embedding provider.");
      }

      const queryVector = normalizeVector(res.embeddings[0]);

      const result = await workerBridge.dispatch("RETRIEVE_AND_RANK_KB", {
        queryText,
        queryVector,
        topK,
        tokenBudget: this.tokenBudget,
        penaltyFactor: this.penaltyFactor,
        similarityThreshold: this.similarityThreshold,
        sessionId,
      }, options);

      const workerResults = result ? result.results || [] : [];
      
      // Hierarchical Deduplication and Parent Context Restoration
      // Group by docId, merge adjacent chunks
      let finalResults = [];
      let totalTokens = 0;

      const groupedByDoc = new Map();
      for (const hit of workerResults) {
        if (!groupedByDoc.has(hit.docId)) {
          groupedByDoc.set(hit.docId, []);
        }
        groupedByDoc.get(hit.docId).push(hit);
      }
      
      // We will count tokens to ensure we stay in budget
      const textsToCount = [];

      // Sort by chunkIndex and merge adjacent
      const mergedHits = [];
      for (const [docId, hits] of groupedByDoc.entries()) {
        hits.sort((a, b) => a.chunkIndex - b.chunkIndex);
        
        let currentMerge = null;
        for (const hit of hits) {
           if (!currentMerge) {
              currentMerge = { ...hit };
           } else {
              if (hit.chunkIndex <= currentMerge.chunkIndex + 1) { // adjacent or overlap
                 currentMerge.text += "\n" + hit.text;
                 currentMerge.chunkIndex = hit.chunkIndex; // update end index
              } else {
                 mergedHits.push(currentMerge);
                 currentMerge = { ...hit };
              }
           }
        }
        if (currentMerge) {
           mergedHits.push(currentMerge);
        }
      }
      
      // Rank merged hits by highest score among its constituent parts? 
      // Actually we should sort merged hits by their original score, but merged score could be the max of its parts
      mergedHits.sort((a, b) => b.score - a.score);

      for (const item of mergedHits) {
        textsToCount.push(item.text || "");
      }

      let tokenCounts = [];
      if (textsToCount.length > 0) {
        try {
          const countResult = await workerBridge.dispatch("BATCH_COUNT_TOKENS", { texts: textsToCount });
          tokenCounts = countResult?.tokensArray || new Array(textsToCount.length).fill(0);
        } catch (err) {
          tokenCounts = new Array(textsToCount.length).fill(0);
        }
      }

      for (let i = 0; i < mergedHits.length; i++) {
        const hit = mergedHits[i];
        let tokens = tokenCounts[i];

        if (totalTokens + tokens > this.tokenBudget) {
          continue; 
        }

        finalResults.push({
          ...hit,
          title: hit.title || "Knowledge Base",
        });
        totalTokens += tokens;

        if (finalResults.length >= topK) break;
      }

      return finalResults;
    } catch (error) {
      console.warn("[KbRagEngine] retrieveRelevantMemories failed:", error);
      return [];
    }
  }
}

export const kbRagEngine = new KbRagEngine();
