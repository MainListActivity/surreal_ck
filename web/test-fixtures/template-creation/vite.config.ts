import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";
const fixture = (name:string)=>fileURLToPath(new URL(name,import.meta.url));
export default defineConfig({root:fixture("."),plugins:[svelte({compilerOptions:{runes:true}})],
 resolve:{alias:[
 {find:"../lib/workbooks.svelte",replacement:fixture("mocks.ts")},
 {find:"../lib/workbook-templates.svelte",replacement:fixture("mocks.ts")},
 {find:"../lib/permissions.svelte",replacement:fixture("mocks.ts")},
 {find:"../components/TemplateCheckRulesDialog.svelte",replacement:fixture("dialog.svelte")},
 ]},server:{host:"127.0.0.1",port:18523,strictPort:true,fs:{allow:[fixture("../../..")]}}});
