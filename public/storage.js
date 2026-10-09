let dbPromise;
function database(){return dbPromise ||= new Promise((resolve,reject)=>{const req=indexedDB.open('novel-harbor',2);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('jobs'))req.result.createObjectStore('jobs',{keyPath:'id'});if(!req.result.objectStoreNames.contains('settings'))req.result.createObjectStore('settings');if(!req.result.objectStoreNames.contains('chapters')){const chapters=req.result.createObjectStore('chapters',{keyPath:'key'});chapters.createIndex('jobId','jobId');}};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
async function operation(store,mode,fn){const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction(store,mode),req=fn(tx.objectStore(store));let value;req.onsuccess=()=>{value=req.result;};tx.oncomplete=()=>resolve(value);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error || new Error('本地保存失败'));});}
export const store={
  async jobs(){const [jobs,content]=await Promise.all([operation('jobs','readonly',s=>s.getAll()),operation('chapters','readonly',s=>s.getAll())]);const lookup=new Map(content.map(c=>[c.key,c.data]));return jobs.map(j=>({...j,chapters:j.chapters.map(c=>({...c,...lookup.get(j.id+'|'+c.url)}))}));},
  saveJob:j=>operation('jobs','readwrite',s=>s.put({...j,chapters:j.chapters.map(({text,...c})=>c)})),
  saveChapter:(j,c)=>operation('chapters','readwrite',s=>s.put({key:j.id+'|'+c.url,jobId:j.id,data:c})),
  async deleteJob(id){const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction(['jobs','chapters'],'readwrite');tx.objectStore('jobs').delete(id);const cursor=tx.objectStore('chapters').index('jobId').openCursor(IDBKeyRange.only(id));cursor.onsuccess=()=>{const c=cursor.result;if(c){c.delete();c.continue();}};tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});},
  get:k=>operation('settings','readonly',s=>s.get(k)),set:(k,v)=>operation('settings','readwrite',s=>s.put(v,k))
};
