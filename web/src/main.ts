import "./app.css";
import { mount } from "svelte";

const target = document.getElementById("app");
if (!target) throw new Error("#app not found");

if (window.location.pathname === "/meeting/guest") {
  const token = window.location.hash.slice(1);
  window.history.replaceState(null, "", "/meeting/guest");
  void import("./features/meeting/GuestMeetingScreen.svelte").then(({ default: GuestMeetingScreen }) =>
    mount(GuestMeetingScreen, { target, props: { token } }));
} else {
  void import("./App.svelte").then(({ default: App }) => mount(App, { target }));
}
