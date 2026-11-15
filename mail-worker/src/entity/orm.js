import { drizzle } from 'drizzle-orm/better-sqlite3';

export default function orm(c) {
	return c.env.orm || drizzle(c.env.db, { logger: c.env.orm_log })
}
