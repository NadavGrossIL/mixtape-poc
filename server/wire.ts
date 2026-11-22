// The card as it travels: the server streams it to the browser in the "done"
// event, and the browser sends it back, whole, with every refine. One
// definition, so the two ends cannot drift, and the one the adjust route
// parses the returned card with.
//
// Every field and its optionality comes from the code that builds the card
// (curator-lc.ts runOnThread, spotify.ts resolveTrack, the generate and adjust
// routes in index.ts), so a card this server produced always parses. Loose
// where that code is loose, never tighter. Unknown fields are dropped on
// parse (zod's default), so nothing a caller adds is echoed back.
//
// Shape order is the order the server writes the keys in, and parsing emits
// keys in shape order, so a real card round-trips byte-identical.
//
// The client cannot import this file: the production build type-checks the
// client before server/node_modules (and so zod) is installed. It keeps its
// own declarations in client/src/types.ts, and test/wire.test.ts fails the
// gate if they stop being identical to the types below.

import { z } from "zod";

// The accent colours the curator may pick. The model's tool enum
// (curator.ts), LangChain's argument check (curator-lc.ts) and the client's
// ink map all come from this list.
const ACCENTS = ["ember", "rose", "plum", "cobalt", "forest", "rust"] as const;
type Accent = (typeof ACCENTS)[number];

const WireTrackSchema = z.object({
  // the search result the curator picked this track from; a refine sends it
  // back so resolution can look the record up directly. Absent on cards made
  // before refs existed.
  ref: z.string().optional(),
  artist: z.string(),
  title: z.string(),
  note: z.string(),
  // Set on every track by resolution, which runs before any card is sent.
  resolved: z.boolean(),
  // The rest exist only on a resolved track (spotify.ts ResolvedFields), and
  // durationMs/year only on cards made since they were added.
  spotifyUrl: z.string().nullable().optional(),
  spotifyUri: z.string().nullable().optional(),
  albumArt: z.string().nullable().optional(),
  matchedName: z.string().optional(),
  durationMs: z.number().nullable().optional(),
  year: z.number().nullable().optional(),
});

const WireCardSchema = z.object({
  title: z.string(),
  vibe: z.string(),
  // A plain string, not the enum: cards curated before the current palette
  // carry accent names that no longer exist, and the client already falls
  // back to ember for those.
  accent: z.string(),
  // Count limits stay in index.ts (MAX_CARD_TRACKS, and the empty check),
  // with their own messages.
  tracks: z.array(WireTrackSchema),
  // the curator's memory thread for this card (curator-lc.ts)
  threadId: z.string().optional(),
  prompt: z.string().optional(),
  seed: z.object({ id: z.string().optional(), name: z.string() }).optional(),
});

type WireTrack = z.infer<typeof WireTrackSchema>;
type WireCard = z.infer<typeof WireCardSchema>;

export { ACCENTS, WireTrackSchema, WireCardSchema };
export type { Accent, WireTrack, WireCard };
