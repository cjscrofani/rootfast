/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    // Override the default palette — we want only the colors we curated.
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      paper:   'var(--rf-paper)',      // warm aged-paper background
      ink:     'var(--rf-ink)',        // deep iron-gall-ink text
      'ink-2': 'var(--rf-ink-2)',      // secondary ink
      'ink-3': 'var(--rf-ink-3)',      // tertiary ink (captions, meta)
      rule:    'var(--rf-rule)',       // hairline rule color
      surface: 'var(--rf-surface)',    // raised surface tone (slightly darker than paper)
      native:  'var(--rf-native)',     // deep forest, for "Native"
      'native-soft':    'var(--rf-native-soft)',
      introduced:       'var(--rf-introduced)', // oxidized rust
      'introduced-soft':'var(--rf-introduced-soft)',
      warn:    'var(--rf-warn)',
      white:   '#FFFFFF',
    },
    fontFamily: {
      serif: ['"EB Garamond"', 'Garamond', 'Georgia', 'serif'],
      sans:  ['"Atkinson Hyperlegible"', 'system-ui', 'sans-serif'],
      mono:  ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
    },
    fontSize: {
      // Adjusted scale: a touch more refined than Tailwind defaults
      'xs':   ['0.7rem',    { lineHeight: '1.05rem',  letterSpacing: '0.04em' }],
      'sm':   ['0.815rem',  { lineHeight: '1.25rem'  }],
      'base': ['0.95rem',   { lineHeight: '1.55rem'  }],
      'lg':   ['1.125rem',  { lineHeight: '1.7rem'   }],
      'xl':   ['1.375rem',  { lineHeight: '1.85rem'  }],
      '2xl':  ['1.75rem',   { lineHeight: '2.1rem'   }],
      '3xl':  ['2.25rem',   { lineHeight: '2.45rem'  }],
      '4xl':  ['3rem',      { lineHeight: '3.15rem'  }],
      '5xl':  ['4rem',      { lineHeight: '4.1rem'   }],
      '6xl':  ['5.25rem',   { lineHeight: '5.25rem'  }],
    },
    extend: {
      maxWidth: {
        prose:   '68ch',
        content: '76rem',
      },
      spacing: {
        '4.5': '1.125rem',
        '18':  '4.5rem',
      },
      letterSpacing: {
        smallcaps: '0.14em',
      },
    },
  },
  plugins: [],
};
