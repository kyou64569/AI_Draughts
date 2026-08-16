/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      screens: {
        // 与 MUI 默认断点对齐，方便 Tailwind 工具类协同
        md: '960px',
      },
    },
  },
  plugins: [],
};
