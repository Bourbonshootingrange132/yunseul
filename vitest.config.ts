import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'jsdom',
		include: ['tests/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'html'],
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.test.ts'],
		},
	},
	resolve: {
		alias: {
			obsidian: new URL('./tests/_stubs/obsidian.ts', import.meta.url).pathname,
		},
	},
});
