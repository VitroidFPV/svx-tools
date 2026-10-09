<script lang="ts">
  let { type }: { type: 'tip' | 'warning' } = $props();
</script>

<aside>{type}</aside>
