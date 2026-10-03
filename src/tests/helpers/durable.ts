/** Serializable storage test double; integration tests also use real SQLite/workerd. */
export function memoryNamespace(Class: new (state: DurableObjectState) => { fetch(request: Request): Promise<Response> }) {
  const states = new Map<string, { storage: any }>();
  const instances = new Map<string, InstanceType<typeof Class>>();
  return {
    restart() { instances.clear(); },
    async alarm(id: string) { await (instances.get(id) as { alarm?: () => Promise<void> } | undefined)?.alarm?.(); },
    idFromName(id: string) { return id; },
    get(id: string) {
      if (!states.has(id)) {
        let data = new Map<string, unknown>(); let queue = Promise.resolve();
        const storage = {
          async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
            const run = queue.then(async () => {
              const copy = structuredClone(data);
              const result = await fn({
                async get(key: string) { return copy.get(key); },
                async put(key: string, value: unknown) { copy.set(key, structuredClone(value)); },
                async delete(key: string) { return copy.delete(key); },
                async list({ prefix = "" } = {}) { return new Map([...copy].filter(([k]) => k.startsWith(prefix))); },
                async setAlarm() {}, async deleteAlarm() {},
              }); data = copy; return result;
            }); queue = run.then(() => {}, () => {}); return run;
          },
          async deleteAll() { data.clear(); },
        }; states.set(id, { storage });
      }
      if (!instances.has(id)) instances.set(id, new Class(states.get(id)! as DurableObjectState));
      return { fetch: (url: string, options?: RequestInit) => instances.get(id)!.fetch(new Request(url, options)) };
    },
  };
}
