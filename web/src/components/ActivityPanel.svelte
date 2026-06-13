<script lang="ts">
</script>

<aside class="activity-panel" aria-label="工作区动态">
  <header>
    <strong>动态</strong>
    <span>待接入</span>
  </header>
  <div class="placeholder">工作区动态将在这里显示</div>
</aside>

<style>
  .activity-panel {
    display: flex;
    width: 280px;
    height: 100%;
    flex-shrink: 0;
    flex-direction: column;
    overflow: hidden;
    border-left: 1px solid var(--border);
    background: var(--surface);
  }

  header {
    display: flex;
    height: 48px;
    flex-shrink: 0;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    border-bottom: 1px solid var(--border);
  }

  strong {
    color: var(--text-1);
    font-size: 13px;
  }

  span,
  .placeholder {
    color: var(--text-3);
    font-size: 12px;
  }

  .placeholder {
    padding: 16px;
  }
</style>
