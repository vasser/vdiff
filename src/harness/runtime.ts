/**
 * Browser-side code appended to the generated harness entry, where `React`, `createRoot`,
 * `Wrapper` and `files` (story file key → module namespace) are in scope.
 *
 * Story discovery follows Component Story Format loosely: every PascalCase named export that is a
 * function (rendered as a component) or an object with `render`/`args` is a story; an object
 * default export is treated as story meta (`component`, `args`).
 */
export const RUNTIME = String.raw`
const isStory = (name, v) =>
  /^[A-Z]/.test(name) &&
  (typeof v === 'function' || (v !== null && typeof v === 'object' && (typeof v.render === 'function' || 'args' in v)));

const element = (story, meta) => {
  const args = { ...(meta.args || {}), ...(story.args || {}) };
  if (typeof story === 'function') return React.createElement(story, args);
  if (typeof story.render === 'function') return React.createElement(() => story.render(args, { args }));
  if (meta.component) return React.createElement(meta.component, args);
  return null;
};

class Boundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { window.__vdiffError = String((error && error.stack) || error); }
  render() {
    return this.state.error
      ? React.createElement('pre', { style: { color: '#b00020', whiteSpace: 'pre-wrap' } }, String(this.state.error))
      : this.props.children;
  }
}

const stories = {};
for (const [file, mod] of Object.entries(files)) {
  const meta = mod.default && typeof mod.default === 'object' ? mod.default : {};
  for (const [name, value] of Object.entries(mod)) {
    if (name !== 'default' && isStory(name, value)) stories[file + '/' + name] = () => element(value, meta);
  }
}
window.__vdiffStories = Object.keys(stories);

const id = new URLSearchParams(location.search).get('story');
if (id) {
  const make = stories[id];
  if (!make) {
    window.__vdiffError = 'Unknown story ' + id;
    window.__vdiffReady = true;
  } else {
    createRoot(document.getElementById('root')).render(
      React.createElement(Boundary, null, React.createElement(Wrapper, { id }, React.createElement(make)))
    );
    requestAnimationFrame(() => requestAnimationFrame(() => { window.__vdiffReady = true; }));
  }
} else {
  window.__vdiffReady = true;
}
`;
