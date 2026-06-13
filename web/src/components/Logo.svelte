<script lang="ts">
  import wordmark from "../assets/wordmark.svg";
  import wordmarkDark from "../assets/wordmark-dark.svg";

  let { size = "md", theme = "light" }: { size?: "sm" | "md"; theme?: "light" | "dark" } = $props();

  const src = $derived(theme === "dark" ? wordmarkDark : wordmark);
  const height = $derived(size === "sm" ? 18 : 24);
</script>

<img {src} alt="logo" {height} class="wordmark" style="width:auto" />

<style>
  .wordmark {
    display: block;
    user-select: none;
  }
</style>
