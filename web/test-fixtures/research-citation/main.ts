import { mount } from "svelte";
import ContentReader from "../../src/screens/ContentReaderScreen.svelte";
import { researchCitationHref } from "../../src/lib/research-citation";
import { body, digest } from "./mocks";
const link = document.createElement("a");
link.id = "fixture-citation";
link.textContent = "打开研究引用的精确版本与位置";
link.href = researchCitationHref("fixture", { index: 1, resourceId: "content_item:a", title: "测试内容",
  platformContent: { itemId: "content_item:a", versionId: "content_version:a", versionPublicId: "a-v1", sourceKey: "fixture",
    locator: { start: 2, end: body.length, bodyDigest: new URLSearchParams(location.search).has("mismatch") ? "bad" : digest } } })!;
document.body.prepend(link);
mount(ContentReader, { target: document.querySelector("#app")!, props: { slug: "fixture", publicId: "a-v1", onback: () => {} } });
