export type StateWriteResult<T=unknown>={readonly ok:true;readonly detail:T}|{readonly ok:false;readonly reason:string};
export const stateWriteOk=<T>(detail:T):StateWriteResult<T>=>({ok:true,detail});
export const stateWriteFailed=(reason:string):StateWriteResult<never>=>({ok:false,reason});

