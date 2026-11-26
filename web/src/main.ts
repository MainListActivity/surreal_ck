import "./app.css";
import { mount } from "svelte";

const target = document.getElementById("app");
if (!target) throw new Error("#app not found");

if (window.location.pathname === "/meeting/roster") {
  const link = new URLSearchParams(window.location.hash.slice(1));
  window.history.replaceState(null, "", "/meeting/roster");
  void import("./features/meeting/RosterMeetingScreen.svelte").then(({ default: RosterMeetingScreen }) =>
    mount(RosterMeetingScreen, { target, props: { pass: link.get("pass") ?? "", checkLabel: link.get("check_label") ?? "" } }));
} else if (window.location.pathname === "/meeting/guest") {
  const token = window.location.hash.slice(1);
  window.history.replaceState(null, "", "/meeting/guest");
  void import("./features/meeting/GuestMeetingScreen.svelte").then(({ default: GuestMeetingScreen }) =>
    mount(GuestMeetingScreen, { target, props: { token } }));
} else {
  void import("./App.svelte").then(({ default: App }) => mount(App, { target }));
}
