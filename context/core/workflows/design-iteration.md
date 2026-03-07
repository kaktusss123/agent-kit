<!-- Context: workflows/design-iteration | Priority: high | Version: 1.0 | Updated: 2025-12-09 -->
# Design Iteration Workflow

## Overview

A structured 4-stage workflow for creating and iterating on UI designs. This process ensures thoughtful design decisions with user approval at each stage.

## Quick Reference

**Stages**: Layout → Theme → Animation → Implementation
**Approval**: Required between each stage
**Output**: Single HTML file per design iteration
**Location**: `design_iterations/` folder

---

## Workflow Stages

### Stage 1: Layout Design

**Purpose**: Define the structure and component hierarchy before visual design

**Process**:
1. Analyze user requirements
2. Identify core UI components
3. Plan layout structure and responsive behavior
4. Create ASCII wireframe
5. Present to user for approval

**Deliverable**: ASCII wireframe with component breakdown

**Example Output**:

```
## Core UI Components

**Header Area**
- Logo/brand (Top left)
- Navigation menu (Top center)
- User actions (Top right)

**Main Content Area**
- Hero section (Full width)
- Feature cards (3-column grid on desktop, stack on mobile)
- Call-to-action (Centered)

**Footer**
- Links (4-column grid)
- Social icons (Centered)
- Copyright (Bottom)

## Layout Structure

Desktop (1024px+):
┌─────────────────────────────────────────────────┐
│ [Logo]        Navigation        [User Menu]     │
├─────────────────────────────────────────────────┤
│                                                 │
│              HERO SECTION                       │
│         (Full width, centered text)             │
│                                                 │
├─────────────────────────────────────────────────┤
│  ┌─────────┐  ┌─────────┐  ┌─────────┐         │
│  │ Card 1  │  │ Card 2  │  │ Card 3  │         │
│  │         │  │         │  │         │         │
│  └─────────┘  └─────────┘  └─────────┘         │
├─────────────────────────────────────────────────┤
│              [Call to Action]                   │
├─────────────────────────────────────────────────┤
│  Links    Links    Links    Social              │
│                    Copyright                    │
└─────────────────────────────────────────────────┘

Mobile (< 768px):
┌─────────────────┐
│ ☰  Logo   [👤]  │
├─────────────────┤
│                 │
│  HERO SECTION   │
│                 │
├─────────────────┤
│  ┌───────────┐  │
│  │  Card 1   │  │
│  └───────────┘  │
│  ┌───────────┐  │
│  │  Card 2   │  │
│  └───────────┘  │
│  ┌───────────┐  │
│  │  Card 3   │  │
│  └───────────┘  │
├─────────────────┤
│      [CTA]      │
├─────────────────┤
│     Links       │
│     Social      │
│   Copyright     │
└─────────────────┘
```

**Approval Gate**: "Would you like to proceed with this layout or need modifications?"

---

### Stage 2: Theme Design

**Purpose**: Define colors, typography, spacing, and visual style

**Process**:
1. Choose design system (neo-brutalism, modern dark, custom)
2. Select color palette (avoid Bootstrap blue unless requested)
3. Choose typography (Google Fonts)
4. Define spacing and shadows
5. Generate theme CSS file
6. Present theme to user for approval

**Deliverable**: CSS theme file saved to `design_iterations/theme_N.css`

**Theme Selection Criteria**:

| Style | Use When | Avoid When |
|-------|----------|------------|
| Neo-Brutalism | Creative/artistic projects, retro aesthetic | Enterprise apps, accessibility-critical |
| Modern Dark | SaaS, developer tools, professional dashboards | Playful consumer apps |
| Custom | Specific brand requirements | Time-constrained projects |

**Example Output**:

```
## Theme Design: Modern Professional

**Style Reference**: Vercel/Linear aesthetic
**Color Palette**: Monochromatic with accent
**Typography**: Inter (UI) + JetBrains Mono (code)
**Spacing**: 4px base unit
**Shadows**: Subtle, soft elevation

**Theme File**: design_iterations/theme_1.css

Key Design Decisions:
- Primary: Neutral gray for professional feel
- Accent: Subtle blue for interactive elements
- Radius: 0.625rem for modern, friendly feel
- Shadows: Soft, minimal elevation
- Fonts: System-like for familiarity
```

**File Naming**: `theme_1.css`, `theme_2.css`, etc.

**Approval Gate**: "Does this theme match your vision, or would you like adjustments?"

---

### Stage 3: Animation Design

**Purpose**: Define micro-interactions and transitions

**Process**:
1. Identify key interactions (hover, click, scroll)
2. Define animation timing and easing
3. Plan loading states and transitions
4. Document animations using micro-syntax
5. Present animation plan to user for approval

**Deliverable**: Animation specification in micro-syntax format

**Example Output**:

```
## Animation Design: Smooth & Professional

### Button Interactions
hover: 200ms ease-out [Y0→-2, shadow↗]
press: 100ms ease-in [S1→0.95]
ripple: 400ms ease-out [S0→2, α1→0]

### Card Interactions
cardHover: 300ms ease-out [Y0→-4, shadow↗]
cardClick: 200ms ease-out [S1→1.02]

### Page Transitions
pageEnter: 300ms ease-out [α0→1, Y+20→0]
pageExit: 200ms ease-in [α1→0]

### Loading States
spinner: 1000ms ∞ linear [R360°]
skeleton: 2000ms ∞ [bg: muted↔accent]

### Micro-Interactions
inputFocus: 200ms ease-out [S1→1.01, ring]
linkHover: 250ms ease-out [underline 0→100%]

**Philosophy**: Subtle, purposeful animations that enhance UX without distraction
**Performance**: All animations use transform/opacity for 60fps
**Accessibility**: Respects prefers-reduced-motion
```

**Approval Gate**: "Are these animations appropriate for your design, or should we adjust?"

---

### Stage 4: Implementation

**Purpose**: Generate complete HTML file with all components

**Process**:
1. Build individual UI components
2. Integrate theme CSS
3. Add animations and interactions
4. Combine into single HTML file
5. Test responsive behavior
6. Save to design_iterations folder
7. Present to user for review

**Deliverable**: Complete HTML file with embedded or linked CSS

**File Organization**:

```
design_iterations/
├── theme_1.css              # Theme file from Stage 2
├── dashboard_1.html         # Initial design
├── dashboard_1_1.html       # First iteration
├── dashboard_1_2.html       # Second iteration
├── chat_ui_1.html           # Different design
└── chat_ui_1_1.html         # Iteration of chat UI
```

**Naming Conventions**:

| Type | Format | Example |
|------|--------|---------|
| Initial design | `{name}_1.html` | `table_1.html` |
| First iteration | `{name}_1_1.html` | `table_1_1.html` |
| Second iteration | `{name}_1_2.html` | `table_1_2.html` |
| New design | `{name}_2.html` | `table_2.html` |

**Implementation Checklist**:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Design Name</title>
  
  <!-- ✅ Preconnect to external resources -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  
  <!-- ✅ Load fonts -->
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  
  <!-- ✅ Load Tailwind (script tag, not stylesheet) -->
  <script src="https://cdn.tailwindcss.com"></script>
  
  <!-- ✅ Load Flowbite if needed -->
  <link href="https://cdn.jsdelivr.net/npm/flowbite@2.0.0/dist/flowbite.min.css" rel="stylesheet">
  
  <!-- ✅ Load icons -->
  <script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
  
  <!-- ✅ Link theme CSS -->
  <link rel="stylesheet" href="theme_1.css">
  
  <!-- ✅ Custom styles with !important for overrides -->
  <style>
    body {
      font-family: 'Inter', sans-serif !important;
      color: var(--foreground) !important;
    }
    
    h1, h2, h3, h4, h5, h6 {
      font-weight: 600 !important;
    }
    
    /* Custom animations */
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }
    
    .animate-fade-in {
      animation: fadeIn 300ms ease-out;
    }
  </style>
</head>
<body>
  <!-- ✅ Semantic HTML structure -->
  <header>
    <!-- Header content -->
  </header>
  
  <main>
    <!-- Main content -->
  </main>
  
  <footer>
    <!-- Footer content -->
  </footer>
  
  <!-- ✅ Load Flowbite JS if needed -->
  <script src="https://cdn.jsdelivr.net/npm/flowbite@2.0.0/dist/flowbite.min.js"></script>
  
  <!-- ✅ Initialize icons -->
  <script>
    lucide.createIcons();
  </script>
  
  <!-- ✅ Custom JavaScript -->
  <script>
    // Interactive functionality
  </script>
</body>
</html>
```

**Approval Gate**: "Please review the design. Would you like any changes or iterations?"

---

## Iteration Process

### When to Create Iterations

**Create new iteration** (`{name}_1_1.html`) when:
- User requests changes to existing design
- Refining based on feedback
- A/B testing variations
- Progressive enhancement

**Create new design** (`{name}_2.html`) when:
- Complete redesign requested
- Different approach/style
- Alternative layout structure

### Iteration Workflow

```
User: "Can you make the buttons larger and change the color?"

1. Read current file: dashboard_1.html
2. Make requested changes
3. Save as: dashboard_1_1.html
4. Present changes to user

User: "Perfect! Now can we add a sidebar?"

1. Read current file: dashboard_1_1.html
2. Add sidebar component
3. Save as: dashboard_1_2.html
4. Present changes to user
```

---

## Best Practices

### Layout Stage

✅ **Do**:
- Use ASCII wireframes for clarity
- Break down into component hierarchy
- Plan responsive behavior upfront
- Consider mobile-first approach
- Get approval before proceeding

❌ **Don't**:
- Skip wireframing and jump to code
- Ignore responsive considerations
- Proceed without user approval
- Over-complicate initial layout

### Theme Stage

✅ **Do**:
- Reference design system context files
- Use CSS custom properties
- Save theme to separate file
- Consider accessibility (contrast ratios)
- Avoid Bootstrap blue unless requested

❌ **Don't**:
- Hardcode colors in HTML
- Use generic/overused color schemes
- Skip contrast testing
- Mix color formats (stick to OKLCH)

### Animation Stage

✅ **Do**:
- Use micro-syntax for documentation
- Keep animations under 400ms
- Use transform/opacity for performance
- Respect prefers-reduced-motion
- Make animations purposeful

❌ **Don't**:
- Animate width/height (use scale)
- Create distracting animations
- Ignore performance implications
- Skip accessibility considerations

### Implementation Stage

✅ **Do**:
- Use single HTML file per design
- Load Tailwind via script tag
- Reference theme CSS file
- Use !important for framework overrides
- Test responsive behavior
- Provide alt text for images
- Use semantic HTML

❌ **Don't**:
- Split into multiple files
- Load Tailwind as stylesheet
- Inline all styles
- Skip accessibility attributes
- Use made-up image URLs
- Use div soup (non-semantic HTML)

---

## File Management

### Folder Structure

```
design_iterations/
├── theme_1.css
├── theme_2.css
├── landing_1.html
├── landing_1_1.html
├── landing_1_2.html
├── dashboard_1.html
├── dashboard_1_1.html
└── navigation.md (optional: design notes)
```

### Version Control

**Track iterations**:
- Initial: `design_1.html`
- Iteration 1: `design_1_1.html`
- Iteration 2: `design_1_2.html`
- Iteration 3: `design_1_3.html`

**New major version**:
- Complete redesign: `design_2.html`
- Then iterate: `design_2_1.html`, `design_2_2.html`

---

## Communication Patterns

### Stage Transitions

**After Layout**:
```
"Here's the proposed layout structure. The design uses a [description].
Would you like to proceed with this layout, or should we make adjustments?"
```

**After Theme**:
```
"I've created a [style] theme with [key features]. The theme file is saved as theme_N.css.
Does this match your vision, or would you like to adjust colors/typography?"
```

**After Animation**:
```
"Here's the animation plan using [timing/style]. All animations are optimized for performance.
Are these animations appropriate, or should we adjust the timing/effects?"
```

**After Implementation**:
```
"I've created the complete design as {filename}.html. The design includes [key features].
Please review and let me know if you'd like any changes or iterations."
```

### Iteration Requests

**User requests change**:
```
"I'll update the design with [changes] and save it as {filename}_N.html.
This preserves the previous version for reference."
```

---

## Quality Checklist

Before presenting each stage:

**Layout Stage**:
- [ ] ASCII wireframe is clear and detailed
- [ ] Components are well-organized
- [ ] Responsive behavior is planned
- [ ] User approval requested

**Theme Stage**:
- [ ] Theme file created and saved
- [ ] Colors use OKLCH format
- [ ] Fonts loaded from Google Fonts
- [ ] Contrast ratios meet WCAG AA
- [ ] User approval requested

**Animation Stage**:
- [ ] Animations documented in micro-syntax
- [ ] Timing is appropriate (< 400ms)
- [ ] Performance optimized (transform/opacity)
- [ ] Accessibility considered
- [ ] User approval requested

**Implementation Stage**:
- [ ] Single HTML file created
- [ ] Theme CSS referenced
- [ ] Tailwind loaded via script tag
- [ ] Icons initialized
- [ ] Responsive design tested
- [ ] Accessibility attributes added
- [ ] Images use valid placeholder URLs
- [ ] Semantic HTML used
- [ ] User review requested

---

## Troubleshooting

### Common Issues

**Issue**: User wants to skip stages
**Solution**: Explain benefits of structured approach, but accommodate if insisted

**Issue**: Theme doesn't match user vision
**Solution**: Iterate on theme file, create theme_2.css with adjustments

**Issue**: Animations feel too slow/fast
**Solution**: Adjust timing in micro-syntax, regenerate with new values

**Issue**: Design doesn't work on mobile
**Solution**: Review responsive breakpoints, add mobile-specific styles

**Issue**: Colors have poor contrast
**Solution**: Use WCAG contrast checker, adjust OKLCH lightness values

---

## References

- [Design Systems Context](../development/design-systems.md)
- [UI Styling Standards](../development/ui-styling-standards.md)
- [Animation Patterns](../development/animation-patterns.md)
- [Design Assets](../development/design-assets.md)
- [ASCII Art Generator](https://www.asciiart.eu/)
- [WCAG Contrast Checker](https://webaim.org/resources/contrastchecker/)
