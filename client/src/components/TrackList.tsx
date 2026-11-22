import { useEffect, useRef } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardCode,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import TrackRow from "./TrackRow";
import { sortableId, spotifySearchUrl } from "../card";
import { type Track } from "../types";

// The card's sortable track list: the drag sensors, the drop handler, the
// click-after-drop guard, and putting focus back on a row a keyboard drop
// moved. The reorder itself is App's (`onReorder`, with sortableIds); this
// only says which row went where.
//
// The refocus effect depends on three things staying true: this component
// stays mounted across a reorder, every reorder hands it a new `tracks`
// array, and `.track-list`'s direct children are the rows.
export default function TrackList({
  tracks,
  accentInk,
  editable,
  adjusting,
  onReorder,
  onSwap,
}: {
  tracks: Track[];
  accentInk: string;
  editable: boolean;
  adjusting: boolean;
  onReorder: (activeId: string, overId: string) => void;
  onSwap: (i: number, t: Track) => void;
}) {
  // drag-to-reorder: the whole row is the drag surface. Mouse drags activate
  // after 8px (a click still opens Spotify); touch needs a 250ms hold so a
  // finger can still scroll the list — moving during the hold cancels the drag.
  // Keyboard: the row already announces itself as sortable ("press space bar
  // to pick up"), so Space picks up, arrows move, Space drops, Escape
  // cancels. Enter is taken out of the start keys — on a row Enter opens the
  // song, and dnd-kit's default would have made it pick the row up instead.
  // It stays an end key: mid-drag it drops (and dnd-kit swallows the key)
  // rather than opening the link with the row still in the air.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: {
        start: [KeyboardCode.Space],
        cancel: [KeyboardCode.Esc],
        end: [KeyboardCode.Space, KeyboardCode.Enter, KeyboardCode.Tab],
      },
    })
  );
  const justDragged = useRef(false);
  // a keyboard drop's new position, focused once the reordered card renders
  // (see onDragEnd)
  const refocusRowRef = useRef<number | null>(null);
  const trackListRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const i = refocusRowRef.current;
    if (i === null) return;
    refocusRowRef.current = null;
    (trackListRef.current?.children[i] as HTMLElement | undefined)?.focus();
  }, [tracks]);

  const onDragEnd = ({ active, over, activatorEvent }: DragEndEvent) => {
    // the click that follows a drop must not open the track
    justDragged.current = true;
    setTimeout(() => (justDragged.current = false), 0);
    if (over && active.id !== over.id) {
      // A keyboard drop must leave focus on the row that moved. Row keys are
      // positional (sortableId), so the moved row remounts and focus falls to
      // the page — dnd-kit's own focus restore looks the row up by its old,
      // now-gone id. arrayMove puts it at `over`'s index.
      if (activatorEvent instanceof KeyboardEvent) {
        refocusRowRef.current = tracks.map(sortableId).indexOf(over.id as string);
      }
      // dnd-kit's UniqueIdentifier is string | number; ours are always the
      // sortableId strings handed to SortableContext below
      onReorder(active.id as string, over.id as string);
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
    >
      <SortableContext
        items={tracks.map(sortableId)}
        strategy={verticalListSortingStrategy}
      >
        <div className="track-list" ref={trackListRef}>
          {tracks.map((t, i) => (
            <TrackRow
              key={sortableId(t, i)}
              id={sortableId(t, i)}
              t={t}
              index={i}
              accentInk={accentInk}
              editable={editable}
              adjusting={adjusting}
              href={
                t.resolved && t.spotifyUrl ? t.spotifyUrl : spotifySearchUrl(t)
              }
              justDragged={justDragged}
              onSwap={() => onSwap(i, t)}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
