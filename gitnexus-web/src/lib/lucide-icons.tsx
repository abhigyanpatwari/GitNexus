/**
 * Centralized icon re-exports from lucide-react.
 *
 * All components import icons from this module (@/lib/lucide-icons) rather
 * than directly from lucide-react. This provides a single place to manage
 * which icons are used and allows future optimization (e.g., tree-shaking
 * configuration, icon subset bundling) without touching every component.
 *
 * --- Why a local `Github` icon? ---
 *
 * Lucide removed all brand icons in v1
 * (https://lucide.dev/guide/react/migration,
 *  https://github.com/lucide-icons/lucide/blob/main/BRAND_LOGOS_STATEMENT.md),
 * so `import { Github } from 'lucide-react'` no longer compiles.
 *
 * We replace it with the official mark from Primer Octicons — the icon set
 * GitHub itself uses on github.com — copied verbatim. This was preferred over
 * the alternatives because it:
 *
 *   1. Is the canonical GitHub-maintained source for the mark, kept in sync
 *      with what users see on github.com.
 *   2. Is MIT-licensed (Copyright (c) GitHub Inc.,
 *      https://github.com/primer/octicons/blob/main/LICENSE), so embedding the
 *      path data is permitted.
 *   3. Adds zero new npm dependencies (vs. `@primer/octicons-react`,
 *      `react-icons`, or `simple-icons`), keeping the web bundle lean.
 *   4. Ships per-size hand-tuned glyphs (16 + 24) — the same approach Primer
 *      uses — so the mark stays crisp at the small `h-4 w-4` sites in the
 *      header and onboarding screens as well as at full size.
 *
 * Trademark note: the GitHub mark is a registered trademark of GitHub, Inc.
 * (https://brand.github.com/foundations/logo). The MIT license covers our
 * right to copy the SVG; trademark rules still govern *use*. We use the mark
 * here only to link to GitHub and to indicate GitHub source-repo integration,
 * which are explicitly permitted by GitHub's brand toolkit.
 *
 * SVG sources (copied verbatim, MIT, Copyright (c) GitHub Inc.):
 *   - https://github.com/primer/octicons/blob/main/icons/mark-github-16.svg
 *   - https://github.com/primer/octicons/blob/main/icons/mark-github-24.svg
 */
import { forwardRef } from 'react';
import type { LucideProps } from 'lucide-react';

export {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  AtSign,
  Brain,
  Box,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Code,
  Copy,
  Eye,
  EyeOff,
  FileArchive,
  FileCode,
  Filter,
  FlaskConical,
  Focus,
  Folder,
  FolderOpen,
  GitBranch,
  Globe,
  Hash,
  Heart,
  HelpCircle,
  Home,
  Key,
  Layers,
  Lightbulb,
  LightbulbOff,
  List,
  Loader2,
  Maximize2,
  MousePointerClick,
  Network,
  PanelLeft,
  PanelLeftClose,
  PanelRightClose,
  Pause,
  Play,
  RefreshCw,
  Rocket,
  RotateCcw,
  Search,
  Send,
  Server,
  Settings,
  SkipForward,
  Snail,
  Sparkles,
  Square,
  Star,
  Table,
  Target,
  Terminal,
  Trash2,
  Type,
  Upload,
  User,
  Variable,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

/**
 * GitHub mark — local copy of Primer Octicons `mark-github-{16,24}`.
 *
 * Why this exists, why Primer Octicons, and the trademark caveat are documented
 * at the top of this file. Please read that header before changing the SVG
 * paths or swapping the source.
 *
 * API-compatible with `lucide-react` icons (`LucideProps`). The Octicons mark
 * is a *filled* glyph, so the lucide-only stroke props (`strokeWidth`,
 * `absoluteStrokeWidth`) are accepted for type parity but ignored. Color
 * defaults to `currentColor`, so Tailwind `text-*` utilities work the same as
 * with any other icon in this module.
 */
/**
 * GitLab tanuki mark — SVG path data from simple-icons (CC0-1.0).
 *
 * GitLab's logo (the tanuki/fox-head) is a registered trademark of GitLab Inc.
 * We use it here only to indicate GitLab source-repo integration.
 *
 * API-compatible with `lucide-react` icons (`LucideProps`).
 */
export const Gitlab = forwardRef<SVGSVGElement, LucideProps>(function Gitlab(
  {
    size = 24,
    color = 'currentColor',
    className,
    strokeWidth: _strokeWidth,
    absoluteStrokeWidth: _absoluteStrokeWidth,
    ...rest
  },
  ref,
) {
  const numericSize = typeof size === 'string' ? Number.parseFloat(size) : size;
  const useSmallVariant = Number.isFinite(numericSize) && (numericSize as number) <= 16;

  if (useSmallVariant) {
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill={color}
        className={className}
        {...rest}
      >
        <path d="M8 15.282l1.855-5.717H6.145L8 15.282z" />
        <path d="M8 15.282L6.145 9.565H2.333L8 15.282z" />
        <path d="M2.333 9.565l-.944-2.942c-.09-.267.067-.553.333-.553h3.153L2.333 9.565z" />
        <path d="M4.875 6.07L6.145 9.565H2.333l2.542-3.495z" />
        <path d="M13.667 9.565l.944-2.942c.09-.267-.067-.553-.333-.553h-3.153l2.542 3.495z" />
        <path d="M11.125 6.07L9.855 9.565h3.812l-2.542-3.495z" />
        <path d="M8 15.282l1.855-5.717H6.145L8 15.282z" />
      </svg>
    );
  }

  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color}
      className={className}
      {...rest}
    >
      <path d="m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z" />
    </svg>
  );
});

/**
 * Azure DevOps mark — SVG path data from simple-icons (CC0-1.0).
 *
 * The Azure DevOps logo is a registered trademark of Microsoft Corporation.
 * We use it here only to indicate Azure DevOps source-repo integration.
 *
 * API-compatible with `lucide-react` icons (`LucideProps`).
 */
export const AzureDevops = forwardRef<SVGSVGElement, LucideProps>(function AzureDevops(
  {
    size = 24,
    color = 'currentColor',
    className,
    strokeWidth: _strokeWidth,
    absoluteStrokeWidth: _absoluteStrokeWidth,
    ...rest
  },
  ref,
) {
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color}
      className={className}
      {...rest}
    >
      <path d="M0 8.877L2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.798V5.415z" />
    </svg>
  );
});

export const Github = forwardRef<SVGSVGElement, LucideProps>(function Github(
  {
    size = 24,
    color = 'currentColor',
    className,
    strokeWidth: _strokeWidth,
    absoluteStrokeWidth: _absoluteStrokeWidth,
    ...rest
  },
  ref,
) {
  const numericSize = typeof size === 'string' ? Number.parseFloat(size) : size;
  const useSmallVariant = Number.isFinite(numericSize) && (numericSize as number) <= 16;

  if (useSmallVariant) {
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill={color}
        className={className}
        {...rest}
      >
        <path d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656" />
      </svg>
    );
  }

  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color}
      className={className}
      {...rest}
    >
      <path d="M10.226 17.284c-2.965-.36-5.054-2.493-5.054-5.256 0-1.123.404-2.336 1.078-3.144-.292-.741-.247-2.314.09-2.965.898-.112 2.111.36 2.83 1.01.853-.269 1.752-.404 2.853-.404 1.1 0 1.999.135 2.807.382.696-.629 1.932-1.1 2.83-.988.315.606.36 2.179.067 2.942.72.854 1.101 2 1.101 3.167 0 2.763-2.089 4.852-5.098 5.234.763.494 1.28 1.572 1.28 2.807v2.336c0 .674.561 1.056 1.235.786 4.066-1.55 7.255-5.615 7.255-10.646C23.5 6.188 18.334 1 11.978 1 5.62 1 .5 6.188.5 12.545c0 4.986 3.167 9.12 7.435 10.669.606.225 1.19-.18 1.19-.786V20.63a2.9 2.9 0 0 1-1.078.224c-1.483 0-2.359-.808-2.987-2.313-.247-.607-.517-.966-1.034-1.033-.27-.023-.359-.135-.359-.27 0-.27.45-.471.898-.471.652 0 1.213.404 1.797 1.235.45.651.921.943 1.483.943.561 0 .92-.202 1.437-.719.382-.381.674-.718.944-.943" />
    </svg>
  );
});
