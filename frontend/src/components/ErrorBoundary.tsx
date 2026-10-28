import { Component, type ReactNode } from 'react';
import { t as tr } from '../i18n';

// A rendering error in one view shows a message there instead of blanking the whole app. Changing `resetKey`
// (another channel, window or workspace) clears it.
export default class ErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null; key: string }> {
  state = { error: null as Error | null, key: this.props.resetKey };
  static getDerivedStateFromError(error: Error) { return { error }; }
  static getDerivedStateFromProps(props: { resetKey: string }, state: { error: Error | null; key: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }
  componentDidCatch(error: Error) { console.error('view failed to render', error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 40 }} className="col">
        <h3>{tr('Something went wrong in this view.')}</h3>
        <div className="small muted">{this.state.error.message}</div>
        <div className="row"><button onClick={() => this.setState({ error: null })}>{tr('Try again')}</button></div>
      </div>
    );
  }
}
