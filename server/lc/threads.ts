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
//   3. a thread is continued for at most `maxAdjusts` adjusts. Every adjust
//      replays the whole thread to the model — every search result of every
//      round before it — so a card adjusted again and again would cost more
//      each time, without end. After the limit the thread is `spent`: the
//      caller starts a fresh thread from the card alone and drops this one.
// In-memory, like the checkpointer it guards: a restart forgets both together.

function makeThreadBook({
  max,
  maxAdjusts = Infinity,
  onEvict,
}: {
  max: number;
  maxAdjusts?: number;
  onEvict?: (threadId: string) => void;
}) {
  // A Map remembers insertion order, so the first key is the oldest thread.
  const book = new Map<string, { owner: string; adjusts: number }>();
  // Put a thread at the newest end, then let go of the oldest over `max`.
  const keep = (threadId: string, entry: { owner: string; adjusts: number }) => {
    book.delete(threadId);
    book.set(threadId, entry);
    while (book.size > max) {
      const oldest = book.keys().next().value as string;
      book.delete(oldest);
      onEvict?.(oldest);
    }
  };
  return {
    // Record a thread for its owner (re-adding makes it the newest, and keeps
    // its adjust count — re-adding must not be a way around rule 3).
    add(threadId: string, owner: string) {
      keep(threadId, { owner, adjusts: book.get(threadId)?.adjusts ?? 0 });
    },
    owns(threadId: unknown, owner: string): threadId is string {
      return typeof threadId === "string" && book.get(threadId)?.owner === owner;
    },
    // One more adjust was made on this thread (it also becomes the newest).
    // An unknown id is ignored: it may have been evicted while the run ran.
    adjusted(threadId: string) {
      const entry = book.get(threadId);
      if (entry) keep(threadId, { ...entry, adjusts: entry.adjusts + 1 });
    },
    // True when the thread has had all the adjusts it is allowed.
    spent(threadId: string): boolean {
      return (book.get(threadId)?.adjusts ?? 0) >= maxAdjusts;
    },
    drop(threadId: string) {
      if (book.delete(threadId)) onEvict?.(threadId);
    },
    size: () => book.size,
  };
}

export { makeThreadBook };
