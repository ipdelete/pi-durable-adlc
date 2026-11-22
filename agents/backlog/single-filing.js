import { defineExtension, hook, ToolTask, ToolResultEntry, UserEntry } from '@earendil-works/pi-durable';

// The host executes tools sequentially and only A2A submits input. Raw history survives
// restart/compaction: allow one filing attempt per input, not one per conversation.
// Even a failed attempt may have reached GitHub, so ask for inspection rather than retry.
export const SingleFiling = defineExtension({
  name: 'backlog-single-filing',
  hooks: [hook(ToolTask, {
    async beforeTool(call, api, context) {
      if (call.name !== 'create_issue') return;
      let cursor;
      do {
        const page = await api.entries({ order: 'descending' }, 100, cursor, context);
        for (const entry of page.items) {
          if (UserEntry.is(entry)) return;
          if (ToolResultEntry.is(entry) && entry.model?.some((message) => message.toolName === call.name)) {
            return { block: 'Only one filing attempt is allowed per request. Check GitHub before retrying in a new request.' };
          }
        }
        cursor = page.next;
      } while (cursor);
      return { block: 'Cannot identify the backlog request; do not file an issue.' };
    },
  })],
});
