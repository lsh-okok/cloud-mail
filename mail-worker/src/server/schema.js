// Snapshot of the upstream v3.5 schema. Keep database defaults numeric where
// counters are used arithmetically, even when the ORM exposes them as text.
export const BASELINE_SQL = `
CREATE TABLE IF NOT EXISTS email (
 email_id INTEGER PRIMARY KEY AUTOINCREMENT, send_email TEXT, name TEXT,
 sender_email TEXT NOT NULL DEFAULT '', account_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
 subject TEXT, code TEXT NOT NULL DEFAULT '', text TEXT, content TEXT,
 cc TEXT NOT NULL DEFAULT '[]', bcc TEXT NOT NULL DEFAULT '[]', recipient TEXT NOT NULL DEFAULT '[]',
 to_email TEXT NOT NULL DEFAULT '', to_name TEXT NOT NULL DEFAULT '',
 in_reply_to TEXT NOT NULL DEFAULT '', relation TEXT NOT NULL DEFAULT '', message_id TEXT NOT NULL DEFAULT '',
 type INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0, resend_email_id TEXT, message TEXT,
 unread INTEGER NOT NULL DEFAULT 0, create_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 is_del INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS user (
 user_id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, type INTEGER NOT NULL DEFAULT 1,
 password TEXT NOT NULL, salt TEXT NOT NULL, status INTEGER NOT NULL DEFAULT 0,
 create_time TEXT DEFAULT CURRENT_TIMESTAMP, active_time TEXT, create_ip TEXT, active_ip TEXT,
 os TEXT, browser TEXT, device TEXT, sort INTEGER NOT NULL DEFAULT 0,
 send_count INTEGER NOT NULL DEFAULT 0, is_del INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS account (
 account_id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
 status INTEGER NOT NULL DEFAULT 0, latest_email_time TEXT, create_time TEXT DEFAULT CURRENT_TIMESTAMP,
 user_id INTEGER NOT NULL, all_receive INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0,
 is_del INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS attachments (
 att_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, email_id INTEGER NOT NULL,
 account_id INTEGER NOT NULL, key TEXT NOT NULL, filename TEXT, mime_type TEXT, size INTEGER,
 status INTEGER NOT NULL DEFAULT 0, type INTEGER NOT NULL DEFAULT 0, disposition TEXT,
 related TEXT, content_id TEXT, encoding TEXT, create_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS star (
 star_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
 email_id INTEGER NOT NULL, create_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS perm (
 perm_id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, perm_key TEXT,
 pid INTEGER NOT NULL DEFAULT 0, type INTEGER NOT NULL DEFAULT 2, sort REAL
);
CREATE TABLE IF NOT EXISTS role (
 role_id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, key TEXT, description TEXT,
 ban_email TEXT NOT NULL DEFAULT '', ban_email_type INTEGER NOT NULL DEFAULT 0,
 avail_domain TEXT NOT NULL DEFAULT '', sort INTEGER DEFAULT 0, is_default INTEGER DEFAULT 0,
 create_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, user_id INTEGER, send_count INTEGER,
 send_type TEXT NOT NULL DEFAULT 'count', account_count INTEGER
);
CREATE TABLE IF NOT EXISTS role_perm (
 id INTEGER PRIMARY KEY AUTOINCREMENT, role_id INTEGER, perm_id INTEGER
);
CREATE TABLE IF NOT EXISTS verify_record (
 vr_id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 1,
 type INTEGER NOT NULL DEFAULT 0, update_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS oauth (
 oauth_id INTEGER PRIMARY KEY AUTOINCREMENT, oauth_user_id TEXT, username TEXT, name TEXT, avatar TEXT,
 active INTEGER, trust_level INTEGER, silenced INTEGER, create_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 platform INTEGER NOT NULL DEFAULT 0, user_id INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS setting (
 register INTEGER NOT NULL DEFAULT 0, receive INTEGER NOT NULL DEFAULT 0, add_email INTEGER NOT NULL DEFAULT 0,
 many_email INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL DEFAULT 'Cloud Mail', auto_refresh INTEGER NOT NULL DEFAULT 5,
 register_verify INTEGER NOT NULL DEFAULT 1, add_email_verify INTEGER NOT NULL DEFAULT 1,
 reg_verify_count INTEGER NOT NULL DEFAULT 1, add_verify_count INTEGER NOT NULL DEFAULT 1,
 send INTEGER NOT NULL DEFAULT 0, secret_key TEXT, site_key TEXT,
 background TEXT, tg_bot_token TEXT NOT NULL DEFAULT '',
 tg_chat_id TEXT NOT NULL DEFAULT '', tg_bot_status INTEGER NOT NULL DEFAULT 1,
 forward_email TEXT NOT NULL DEFAULT '', forward_status INTEGER NOT NULL DEFAULT 1,
 rule_email TEXT NOT NULL DEFAULT '', rule_type INTEGER NOT NULL DEFAULT 0,
 login_opacity REAL NOT NULL DEFAULT 0.90, resend_tokens TEXT NOT NULL DEFAULT '{}',
 notice_title TEXT NOT NULL DEFAULT 'Cloud Mail', notice_content TEXT NOT NULL DEFAULT '',
 notice_type TEXT NOT NULL DEFAULT 'none', notice_duration INTEGER NOT NULL DEFAULT 0,
 notice_position TEXT NOT NULL DEFAULT 'top-right', notice_offset INTEGER NOT NULL DEFAULT 0,
 notice_width INTEGER NOT NULL DEFAULT 340, notice INTEGER NOT NULL DEFAULT 0,
 no_recipient INTEGER NOT NULL DEFAULT 1, login_domain INTEGER NOT NULL DEFAULT 0,
 custom_domain TEXT NOT NULL DEFAULT '', tg_msg_from TEXT NOT NULL DEFAULT 'only-name',
 tg_msg_to TEXT NOT NULL DEFAULT 'show', tg_msg_text TEXT NOT NULL DEFAULT 'show',
 min_email_prefix INTEGER NOT NULL DEFAULT 1, email_prefix_filter TEXT NOT NULL DEFAULT '',
 black_subject TEXT NOT NULL DEFAULT '', black_content TEXT NOT NULL DEFAULT '', black_from TEXT NOT NULL DEFAULT '',
 ai_code INTEGER NOT NULL DEFAULT 1, sync_delete INTEGER NOT NULL DEFAULT 0, ai_code_filter TEXT NOT NULL DEFAULT '',
 linuxdo_client_id TEXT NOT NULL DEFAULT '', linuxdo_client_secret TEXT NOT NULL DEFAULT '', linuxdo_switch INTEGER NOT NULL DEFAULT 1,
 github_client_id TEXT NOT NULL DEFAULT '', github_client_secret TEXT NOT NULL DEFAULT '', github_switch INTEGER NOT NULL DEFAULT 1,
 google_client_id TEXT NOT NULL DEFAULT '', google_client_secret TEXT NOT NULL DEFAULT '', google_switch INTEGER NOT NULL DEFAULT 1,
 auto_clean_days INTEGER NOT NULL DEFAULT 0, auto_clean_exclude TEXT NOT NULL DEFAULT '',
 webhook_url TEXT NOT NULL DEFAULT '', webhook_status INTEGER NOT NULL DEFAULT 1,
 webhook_retry INTEGER NOT NULL DEFAULT 0, webhook_secret TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_email_nocase ON account(email COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email_nocase ON user(email COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_email_user_id_account_id ON email(user_id, account_id);
CREATE INDEX IF NOT EXISTS idx_email_list_user ON email(user_id, type, is_del, email_id);
CREATE INDEX IF NOT EXISTS idx_email_list_account ON email(user_id, account_id, type, is_del, email_id);
CREATE INDEX IF NOT EXISTS idx_star_user_email ON star(user_id, email_id);
CREATE INDEX IF NOT EXISTS idx_star_email_user ON star(email_id, user_id);
CREATE INDEX IF NOT EXISTS idx_email_name_nocase ON email(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_email_subject_nocase ON email(subject COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_email_to_email_nocase ON email(to_email COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_email_send_email_nocase ON email(send_email COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_email_noone_id ON email(email_id) WHERE status = 7;
CREATE INDEX IF NOT EXISTS idx_email_type_id ON email(type, email_id);
CREATE INDEX IF NOT EXISTS idx_account_user_del_sort ON account(user_id, is_del, sort, account_id);
CREATE INDEX IF NOT EXISTS idx_email_saving_account ON email(account_id) WHERE status = 6;
CREATE INDEX IF NOT EXISTS idx_email_type_name ON email(type, name);
CREATE INDEX IF NOT EXISTS idx_email_type_create_time ON email(type, create_time);
CREATE INDEX IF NOT EXISTS idx_user_create_time ON user(create_time);
CREATE INDEX IF NOT EXISTS idx_user_type ON user(type);
CREATE INDEX IF NOT EXISTS idx_attachments_email_type ON attachments(email_id, type);
CREATE INDEX IF NOT EXISTS idx_attachments_key ON attachments(key);
CREATE INDEX IF NOT EXISTS idx_role_perm_role ON role_perm(role_id);
CREATE INDEX IF NOT EXISTS idx_oauth_oauth_user_id ON oauth(oauth_user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_user_id ON oauth(user_id);
CREATE INDEX IF NOT EXISTS idx_email_create_time ON email(create_time);
CREATE INDEX IF NOT EXISTS idx_email_user_create_time ON email(user_id, create_time);
`;

export const PERMISSIONS = [
	[1, '邮件', null, 0, 0, 0], [2, '邮件删除', 'email:delete', 1, 2, 1], [3, '邮件发送', 'email:send', 1, 2, 0],
	[4, '个人设置', '', 0, 1, 2], [5, '用户注销', 'my:delete', 4, 2, 0], [6, '用户信息', null, 0, 1, 3],
	[7, '用户查看', 'user:query', 6, 2, 0], [8, '密码修改', 'user:set-pwd', 6, 2, 2],
	[9, '状态修改', 'user:set-status', 6, 2, 3], [10, '权限修改', 'user:set-type', 6, 2, 4],
	[11, '用户删除', 'user:delete', 6, 2, 7], [13, '权限控制', '', 0, 1, 5],
	[14, '身份查看', 'role:query', 13, 2, 0], [15, '身份修改', 'role:set', 13, 2, 1],
	[16, '身份删除', 'role:delete', 13, 2, 2], [17, '系统设置', '', 0, 1, 6],
	[18, '设置查看', 'setting:query', 17, 2, 0], [19, '设置修改', 'setting:set', 17, 2, 1],
	[21, '邮箱侧栏', '', 0, 0, 1], [22, '邮箱查看', 'account:query', 21, 2, 0],
	[23, '邮箱添加', 'account:add', 21, 2, 1], [24, '邮箱删除', 'account:delete', 21, 2, 2],
	[25, '用户添加', 'user:add', 6, 2, 1], [26, '发件重置', 'user:reset-send', 6, 2, 6],
	[27, '邮件列表', '', 0, 1, 4], [28, '邮件查看', 'all-email:query', 27, 2, 0],
	[29, '邮件删除', 'all-email:delete', 27, 2, 0], [30, '身份添加', 'role:add', 13, 2, -1],
	[31, '分析页', null, 0, 1, 2.1], [32, '数据查看', 'analysis:query', 31, 2, 1]
];
