// Server deployments initialize the database before accepting requests. Keep a
// harmless response for bookmarks to the upstream secret-bearing init URL.
export const dbInit = {
	async init(c) {
		return c.text('Database initialization is managed during server startup.', 410);
	}
};
