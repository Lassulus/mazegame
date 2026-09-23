// Name tags floating above the other players. The raycaster hands back screen
// positions in buffer pixels; this pools one div per visible player.

export function createTags(container) {
  const tags = new Map();

  return function update(labels, names, scale) {
    const live = new Set();
    for (const label of labels) {
      const name = names.get(label.id);
      if (!name) continue;
      live.add(label.id);
      let tag = tags.get(label.id);
      if (!tag) {
        tag = document.createElement("div");
        tag.className = "tag";
        container.append(tag);
        tags.set(label.id, tag);
      }
      if (tag.textContent !== name) tag.textContent = name;
      tag.style.transform =
        `translate(-50%, -100%) translate(${label.x * scale}px, ${label.y * scale - 4}px)`;
      tag.style.opacity = String(Math.max(0.25, 1 - label.depth / 12));
    }
    for (const [id, tag] of tags) {
      if (live.has(id)) continue;
      tag.remove();
      tags.delete(id);
    }
  };
}
