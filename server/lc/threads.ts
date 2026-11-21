// Who owns which memory thread, and how many are kept.
//
// The LangChain curator remembers each card's conversation under a thread id.
// The id travels to the browser on the card and comes back with an adjust
// request — so it is caller-supplied text, and a card can be shared. Two rules:
//   1. a thread is continued only for the visitor who made it; anyone else
//      (or an id we do not know, e.g. after a restart) starts fresh from the
//      card they sent. Knowing an id is never enough.
//   2. only the newest `max` threads are kept. The checkpointer holds every
//      message of every thread in memory, so without a cap a busy server
//      grows until it dies.
// In-memory, like the checkpointer it guards: a restart forgets both together.

function makeThreadBook({
  max,
  onEvict,
}: {
  max: number;
  onEvict?: (threadId: string) => void;
}) {
  // A Map remembers insertion order, so the first key is the oldest thread.
  const owners = new Map<string, string>();
  return {
    // Record a thread for its owner (re-adding makes it the newest).
    add(threadId: string, owner: string) {
      owners.delete(threadId);
      owners.set(threadId, owner);
      while (owners.size > max) {
        const oldest = owners.keys().next().value as string;
        owners.delete(oldest);
        onEvict?.(oldest);
      }
    },
    owns(threadId: unknown, owner: string): threadId is string {
      return typeof threadId === "string" && owners.has(threadId) && owners.get(threadId) === owner;
    },
    drop(threadId: string) {
      if (owners.delete(threadId)) onEvict?.(threadId);
    },
    size: () => owners.size,
  };
}

export { makeThreadBook };
