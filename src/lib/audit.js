/* Activity log: one row per meaningful action, kept for accountability. */
export const audit=(db,uid,action,detail='')=>db.add('audit',uid,{action,detail,at:Date.now()});
