import app from '../hono/hono';

app.get('/oss/*', async (c) => {
	const key = c.req.path.split('/oss/')[1];
	const resp = await c.env.storage.get(key);
	if (!resp) {
		return c.notFound();
	}
	return resp;
});


