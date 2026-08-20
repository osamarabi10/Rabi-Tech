import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: ['./app/**/*.{js,ts,jsx,tsx}', './components/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans:  ['Cairo', 'system-ui', 'sans-serif'],
        arabic: ['Cairo', 'system-ui', 'sans-serif'],
        mono:  ['IBM Plex Mono', 'monospace'],
      },
      colors: {
        border:      'hsl(var(--border))',
        input:       'hsl(var(--input))',
        ring:        'hsl(var(--ring))',
        background:  'hsl(var(--background))',
        foreground:  'hsl(var(--foreground))',
        primary: {
          DEFAULT:    'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT:    'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT:    'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT:    'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT:    'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT:    'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT:    'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        /* Dark navigation against the light canvas. */
        nav: {
          DEFAULT:    'hsl(var(--nav))',
          foreground: 'hsl(var(--nav-foreground))',
          muted:      'hsl(var(--nav-muted))',
          accent:     'hsl(var(--nav-accent))',
          border:     'hsl(var(--nav-border))',
        },
        /* Functional status. Named by meaning, not colour, so a palette
           change never leaves "green" pointing at something red. */
        success: 'hsl(var(--success))',
        warning: 'hsl(var(--warning))',
        danger:  'hsl(var(--danger))',
        note:    'hsl(var(--note))',
        /* Brighter hues for fills and dots, where contrast rules don't apply. */
        'success-vivid': 'hsl(var(--success-vivid))',
        'warning-vivid': 'hsl(var(--warning-vivid))',
        'danger-vivid':  'hsl(var(--danger-vivid))',
        /* Per-channel brand colours. */
        channel: {
          whatsapp:  'hsl(var(--ch-whatsapp))',
          telegram:  'hsl(var(--ch-telegram))',
          messenger: 'hsl(var(--ch-messenger))',
          instagram: 'hsl(var(--ch-instagram))',
          viber:     'hsl(var(--ch-viber))',
          line:      'hsl(var(--ch-line))',
          sms:       'hsl(var(--ch-sms))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      boxShadow: {
        /* On a light canvas, elevation reads as a soft neutral shadow.
           The old glows were tuned for a near-black background and turn
           into muddy haloes here, so they become real elevation steps. */
        'glow-sm': '0 1px 2px 0 hsl(222 47% 11% / 0.05)',
        'glow':    '0 4px 12px -2px hsl(222 47% 11% / 0.10)',
        'glow-lg': '0 12px 28px -6px hsl(222 47% 11% / 0.16)',
        'card':    '0 1px 2px 0 hsl(222 47% 11% / 0.04), 0 1px 3px 0 hsl(222 47% 11% / 0.06)',
      },
      backgroundImage: {
        'gradient-violet':  'linear-gradient(135deg, hsl(var(--primary)), hsl(var(--ch-telegram)))',
        'gradient-surface': 'linear-gradient(180deg, hsl(var(--card)), hsl(var(--surface-2)))',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
