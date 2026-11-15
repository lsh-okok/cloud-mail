import { Hono } from 'hono';
const app = new Hono();

import result from '../model/result';
import { cors } from 'hono/cors';

app.use('*', cors());

app.onError((err, c) => {
	if (err.name === 'BizError') {
		console.log(err.message);
	} else {
		console.error(err);
	}

	if ((typeof err.code === 'string' && err.code.startsWith('SQLITE_')) || err.message?.includes('no such column')) {
		return c.json(result.fail('数据库操作失败，请检查服务日志<br/>Database operation failed; check server logs', 500));
	}

	return c.json(result.fail(err.message, err.code));
});

export default app;


