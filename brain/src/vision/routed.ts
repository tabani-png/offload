// s14 captioner selection (`serve --captioner auto|claude`): Claude reads the screens when a key is configured and the
// router's budget allows it; otherwise the local Ollama model does, so captions never stop for money or a missing key.
// Images are masked by the engine before either one sees them. With no key and no local model, `auto` is off and the
// status says what is needed (cli.ts).
import type { ClaudeCaptioner } from "./claude.ts";
import { CaptionerFatalError } from "./ollama.ts";
import type { Captioner, CaptionerHealth, CaptionFields, CaptionInput, CaptionUsage } from "./types.ts";

export class RoutedCaptioner implements Captioner {
  readonly kind = "claude" as const;
  /** Set when Claude failed in a way a retry will not fix (no key accepted): the local model takes over. */
  private claudeDown: string | null = null;

  constructor(
    private readonly claude: ClaudeCaptioner,
    private readonly local: Captioner | null,
    /** The router's budget check (captions leave Claude at 80% of the monthly cap). */
    private readonly claudeAllowed: () => boolean,
  ) {}

  private useClaude(): boolean {
    return this.claude.configured && this.claudeDown === null && this.claudeAllowed();
  }

  active(): "stub" | "ollama" | "claude" {
    return this.useClaude() || this.local === null ? "claude" : this.local.kind;
  }

  get model(): string {
    return this.useClaude() || this.local === null ? this.claude.model : this.local.model;
  }

  get id(): string {
    return this.useClaude() || this.local === null ? this.claude.id : this.local.id;
  }

  usage(): CaptionUsage {
    return this.claude.usage();
  }

  async caption(input: CaptionInput, signal?: AbortSignal): Promise<CaptionFields> {
    if (this.useClaude()) {
      try {
        return await this.claude.caption(input, signal);
      } catch (err) {
        if (!(err instanceof CaptionerFatalError) || this.local === null) throw err;
        this.claudeDown = err.message;
      }
    }
    if (this.local === null) throw new CaptionerFatalError(this.claudeDown ?? "Claude is not available for screens and there is no local model");
    return this.local.caption(input, signal);
  }

  async health(): Promise<CaptionerHealth> {
    if (this.useClaude()) {
      const h = await this.claude.health();
      if (h.ok || this.local === null) return h;
      this.claudeDown = h.detail;
    }
    return this.local === null ? { ok: false, detail: this.claudeDown ?? "no Claude account and no local model" } : this.local.health();
  }
}
