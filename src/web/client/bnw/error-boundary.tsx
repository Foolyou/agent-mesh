// Step 7.5-C — stage-level error boundary for the `/bnw` console. Wraps ONLY the surface
// stage (BnwApp body), so a render crash in one surface shows a unified error card with retry
// while the topbar / navigation / bottom tabs stay alive. Matches surface-13's unified
// error+retry treatment (coverage/13-global-states.md). Error boundaries must be class
// components — this is the one class component in the otherwise-functional /bnw tree.
import { Component, type ReactNode } from "react";
import { Button, PanelFrame, RouteLink } from "../ui/index";
import { bnwHref } from "../router";

interface Props {
  children: ReactNode;
  /** When this changes (e.g. the route), a caught error auto-clears so navigation recovers. */
  resetKey?: string;
}
interface State { error: Error | null }

export class BnwErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    // Topbar/nav survive a crash, so navigating to another route must reset the boundary.
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <PanelFrame title="界面错误">
        <div data-bnw-error-boundary className="flex flex-col items-center gap-3 py-8 text-center">
          <span className="text-3xl" aria-hidden="true">💥</span>
          <h2 className="text-base font-semibold text-text-primary">这个界面出错了</h2>
          <p className="max-w-md text-xs text-text-muted">
            渲染时抛出异常——顶栏与导航仍可用。可重试本界面或返回首页。
            {error.message ? <span className="mt-1 block break-all font-mono text-text-secondary">{error.message}</span> : null}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button variant="primary" size="sm" aria-label="retry surface" onClick={this.reset}>重试</Button>
            <RouteLink href={bnwHref({ k: "home" })} onClick={this.reset}>返回首页</RouteLink>
          </div>
        </div>
      </PanelFrame>
    );
  }
}
