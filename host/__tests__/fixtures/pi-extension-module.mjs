import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const root=new URL('../../../preseed/agents/pi/extensions/',import.meta.url),modules=new Map();
function moduleUrl(name){
 if(modules.has(name))return modules.get(name);
 let source=stripTypeScriptTypes(readFileSync(new URL(name+'.ts',root),'utf8'));
 source=source.replace(/from "\.\/([a-z-]+)(?:\.ts)?"/g,(_match,dependency)=>`from "${moduleUrl(dependency)}"`);
 const url='data:text/javascript;base64,'+Buffer.from(source).toString('base64');modules.set(name,url);return url;
}
// Test-only module resolution: production Pi/Jiti and bundler use extensionless imports.
export const importPiExtension=name=>import(moduleUrl(name));
