<script lang="ts">
  let { size = "md" }: { size?: "sm" | "md" } = $props();
</script>

<div class={`logo ${size}`}>
  <span class="mark"><i></i><i></i><i></i><i></i></span>
  <strong>surreal<span>_ck</span></strong>
</div>

<style>
  .logo {
    display: flex;
    align-items: center;
    gap: 8px;
    user-select: none;
  }

  .mark {
    display: grid;
    width: 24px;
    height: 24px;
    grid-template-columns: repeat(2, 1fr);
    gap: 2px;
    padding: 4px;
    border-radius: 5px;
    background: var(--primary);
  }

  .sm .mark {
    width: 20px;
    height: 20px;
    padding: 3px;
  }

  i {
    border-radius: 1px;
    background: #fff;
    opacity: .55;
  }

  i:first-child,
  i:last-child {
    opacity: .92;
  }

  strong {
    color: var(--text-1);
    font-size: 15px;
    font-weight: 650;
    letter-spacing: 0;
  }

  .sm strong {
    font-size: 13px;
  }

  strong span {
    color: var(--primary);
  }
</style>
