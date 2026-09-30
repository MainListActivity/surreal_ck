import { mount } from "svelte";
import Screen from "../../src/screens/TemplatesScreen.svelte";
mount(Screen, {target:document.getElementById("app")!,props:{onopen:(id:string)=>{document.body.dataset.opened=id;}}});
