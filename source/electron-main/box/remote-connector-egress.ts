export function createEgressConnectionObserver<TConnection>() {
  let consumer: (connection: TConnection | null) => void = () => {};
  let epoch = 0;
  const dropObservedConnection = () => { epoch += 1; consumer(null); };
  return {
    wrap<T extends { connect(): Promise<TConnection>; recreate?: (...args: any[]) => any; forceRecreate?: (...args: any[]) => any; issueLocalExecDaemonCredential?: (...args: any[]) => any }>(base: T) {
      return {
        connect: async () => { const dispatched = epoch; try { const connection = await base.connect(); if (epoch === dispatched) consumer(connection); return connection; } catch (error) { if (epoch === dispatched) consumer(null); throw error; } },
        ...(base.recreate == null ? {} : { recreate: base.recreate.bind(base) }),
        ...(base.forceRecreate == null ? {} : { forceRecreate: base.forceRecreate.bind(base) }),
        ...(base.issueLocalExecDaemonCredential == null ? {} : { issueLocalExecDaemonCredential: base.issueLocalExecDaemonCredential.bind(base) }),
      };
    },
    attach(next: (connection: TConnection | null) => void): void { consumer = next; },
    noteAccountDeparted: dropObservedConnection,
    dropObservedConnection,
  };
}
