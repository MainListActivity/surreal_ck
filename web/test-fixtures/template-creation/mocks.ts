export { templateColumnDefs, templateSheetsForCreate } from "../../src/lib/workbook-templates";
const mode = new URLSearchParams(location.search).get("mode");
export const workbookTemplatesStore = {
 loading:false,error:null,templates:mode==="empty"?[]:[{
 id:"workbook_template:equipment",key:"equipment",label:"设备运维模板",defaultName:"设备台账",columnDefs:[],
 sheets:[{key:"assets",label:"设备",columnDefs:mode==="invalid"?null:[{key:"name",label:"名称",field_type:"text"}]}],
 }],load:async()=>{},
};
export const canWriteSharedStructure = ()=>mode!=="member";
export const workbooksStore = {error:null,createFromTemplate:async(template:unknown,_name:unknown,options:unknown)=>{
 document.body.dataset.input=JSON.stringify({template,options});
 return {id:"workbook:ui_created"};
}};
