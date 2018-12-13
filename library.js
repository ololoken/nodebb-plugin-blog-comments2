(function (module) {

	let Comments = {};

	let db = require.main.require('./src/database');
	let meta = require.main.require('./src/meta');
	let posts = require.main.require('./src/posts');
	let topics = require.main.require('./src/topics');
	let user = require.main.require('./src/user');
	let groups = require.main.require('./src/groups');
	let fs = module.parent.require('fs');
	let path = module.parent.require('path');
	let async = module.parent.require('async');
	let winston = module.parent.require('winston');

	module.exports = Comments;

	function CORSSafeReq (req) {
		let hostUrls = (meta.config['blog-comments:url'] || '').split(',');

		let url = hostUrls
			.map(hostUrl => hostUrl.trim())
			.filter(hostUrl => hostUrl.startsWith(req.get('origin')))
			.pop();

		if (!url) {
			winston.warn(`[nodebb-plugin-blog-comments2] Origin (${req.get('origin')}) does not match hostUrls: ${hostUrls.join(', ')}`);
		}
		return url;
	}

	function CORSFilter (req, res) {
		let url = CORSSafeReq(req);

		if (url) {
			res.header('Access-Control-Allow-Origin', url);
			res.header('Access-Control-Allow-Headers', 'X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept');
			res.header('Access-Control-Allow-Credentials', 'true');
		}
	}

	Comments.getTopicIDByCommentID = (commentID, blogger, callback) =>
		db.getObjectField(`blog-comments:${blogger}`, commentID, (err, tid) => callback(err, tid));

	Comments.getCommentData = function(req, res) {
		let commentID = req.params.id;
		let blogger = req.params.blogger || 'default';
		let {uid = 0} = req.user || {};

		Comments.getTopicIDByCommentID(commentID, blogger, (err, tid) => {
			let disabled = false;

			async.parallel({
				posts: (next) => {
					if (disabled) {
						next(err, []);
					}
					else {
						topics.getTopicPosts(tid, `tid:${tid}:posts`, req.params.pagination * 10, 9 + req.params.pagination * 9, uid, true, next);
					}
				},
				postCount: (next) => topics.getTopicField(tid, 'postcount', next),
				user: (next) => user.getUserData(uid, next),
				isAdministrator: (next) => user.isAdministrator(uid, next),
				isPublisher: (next) => groups.isMember(uid, 'publishers', next),
				category: (next) => topics.getCategoryData(tid, next),
				mainPost: (next) => topics.getMainPost(tid, uid, next)
			}, (err, data) => {
				CORSFilter(req, res);

				let posts = data.posts
					.filter(post => post.deleted === false)
					.map(post => Object.assign(post, {
						isReply: post.hasOwnProperty('toPid') && parseInt(post.toPid) !== parseInt(data.tid) - 1,
						parentUsername: post.parent ? post.parent.username || '' : '',
						deletedReply: !!(post.parent && !post.parent.username)
					}));

				let top = true;
				let bottom = false;
				let compose_location = meta.config['blog-comments:compose-location'];

				if (compose_location === 'bottom') {
					bottom = true;
					top = false;
				}

				res.json({
					posts: posts,
					postCount: data.postCount,
					user: data.user,
					template: Comments.template,
					token: req.csrfToken(),
					isAdmin: !data.isAdministrator ? data.isPublisher : data.isAdministrator,
					isLoggedIn: !!uid,
					tid: tid,
					category: data.category,
					mainPost: data.mainPost,
					isValid: !!data.mainPost && !!tid,
					atBottom: bottom,
					atTop: top,
					siteTitle: meta.config.title
				});
			});
		});
	};

	function get_redirect_url(url, err) {
		let rurl = url + '#nodebb-comments';
		if (url.indexOf('#') !== -1) {
			// compatible for mmmw's blog, he uses hash in url;
			rurl = url;
		}

		if (err) {
			rurl = `${url}?error=${err.message}#nodebb-comments`;
			if (url.indexOf('#') !== -1) {
				rurl = `${url.split('#')[0]}?error=${err.message}#${url.split('#')[1]}`;
			}
		}
		return rurl;
	}

	Comments.votePost = (req, res, callback) => {
		if (!CORSSafeReq(req)) {
			return;
		}
		let toPid = req.body.toPid;
		let isUpvote = JSON.parse(req.body.isUpvote);
		let {uid = 0} = req.user || {};

		let func = isUpvote ? 'upvote' : 'unvote';

		posts[func](toPid, uid, (err, result) => {
			CORSFilter(req, res);
			res.json({error: err && err.message, result: result});
		});
	};

	Comments.bookmarkPost = (req, res, callback) => {
		if (!CORSSafeReq(req)) {
			return;
		}
		let toPid = req.body.toPid;
		let isBookmark = JSON.parse(req.body.isBookmark);
		let {uid = 0} = req.user || {};

		let func = isBookmark ? 'bookmark' : 'unbookmark';

		posts[func](toPid, uid, (err, result) => {
			CORSFilter(req, res);
			res.json({error: err && err.message, result: result});
		});
	};

	Comments.replyToComment = (req, res, callback) => {
		let content = req.body.content;
		let tid = req.body.tid;
		let url = req.body.url;
		let toPid = req.body.toPid;
		let {uid = 0} = req.user || {};

		topics.reply({
			tid: tid,
			uid: uid,
			toPid: toPid,
			content: content
		}, (err, postData) => res.redirect(get_redirect_url(url, err)));
	};

	Comments.publishArticle = (req, res, callback) => {
		let markdown = req.body.markdown;
		let title = req.body.title;
		let url = req.body.url;
		let commentID = req.body.id;
		let tags = req.body.tags;
		let blogger = req.body.blogger || 'default';
		let {uid = 0} = req.user || {};
		let cid = JSON.parse(req.body.cid);

		if (cid === -1) {
			let hostUrls = (meta.config['blog-comments:url'] || '').split(',');
			let position = 0;

			hostUrls.forEach((hostUrl, i) => {
				hostUrl = hostUrl.trim();
				if (hostUrl.startsWith(req.get('origin'))) {
					position = i;
				}
			});

			cid = meta.config['blog-comments:cid'].toString() || '';
			cid = parseInt(cid.split(',')[position], 10) || parseInt(cid.split(',')[0], 10) || 1;
		}

		async.parallel({
			isAdministrator: (next) => user.isAdministrator(uid, next),
			isPublisher: (next) => groups.isMember(uid, 'publishers', next)
		}, (err, userStatus) => {
			if (!userStatus.isAdministrator && !userStatus.isPublisher) {
				return res.json({error: "Only Administrators or members of the publishers group can publish articles"});
			}

			topics.post({
				uid: uid,
				title: title,
				content: markdown,
				tags: tags ? JSON.parse(tags) : [],
				req: req,
				externalLink: url,  // save externalLink and externalComment to topic, only v2mm theme can do this.
				externalComment: markdown,
				cid: cid
			}, (err, result) => {
				if (!err && result && result.postData && result.postData.tid) {
					posts.setPostField(result.postData.pid, 'blog-comments:url', url, (err) => {
						if (err) {
							return res.json({error: "Unable to post topic", result: result});
						}

						db.setObjectField(`blog-comments:${blogger}`, commentID, result.postData.tid);
						let rurl = `${(req.header('Referer') || '/')}#nodebb-comments`;
						if (url.indexOf('#') !== -1) {
							// compatible for mmmw's blog, he uses hash in url;
							rurl = url;
						}

						res.redirect(rurl);
					});
				}
				else {
					res.json({error: "Unable to post topic", result: result});
				}
			});
		});

	};

	Comments.addLinkbackToArticle = (post, callback) => {
		let hostUrls = (meta.config['blog-comments:url'] || '').split(',');
		let position;

		posts.getPostField(post.pid, 'blog-comments:url', (err, url) => {
			if (url) {
				hostUrls.forEach((hostUrl, i) => {
					if (url.indexOf(hostUrl.trim().replace(/^https?:\/\//, '')) !== -1) {
						position = i;
					}
				});

				let blogName = (meta.config['blog-comments:name'] || '');
				blogName = parseInt(blogName.split(',')[position], 10) || parseInt(blogName.split(',')[0], 10) || 1;

				post.profile.push({
					content: `Posted from <strong><a href="${url}" target="_blank">${blogName}</a></strong>`
				});
			}

			callback(err, post);
		});
	};

	Comments.addAdminLink = (custom_header, callback) => {
		custom_header.plugins.push({
			'route': '/blog-comments',
			'icon': 'fa-book',
			'name': 'Blog Comments'
		});

		callback(null, custom_header);
	};

	function renderAdmin(req, res, callback) {
		res.render('comments/admin', {});
	}

	Comments.init = function(params, callback) {
		let app = params.router;
		let middleware = params.middleware;
		let controllers = params.controllers;

		fs.readFile(path.resolve(__dirname, './public/templates/comments/comments.tpl'), (err, data) => Comments.template = data.toString());

		app.get('/comments/get/:blogger/:id/:pagination?', middleware.applyCSRF, Comments.getCommentData);
		app.post('/comments/reply', Comments.replyToComment);
		app.post('/comments/publish', Comments.publishArticle);
		app.post('/comments/vote', Comments.votePost);
		app.post('/comments/bookmark', Comments.bookmarkPost);

		app.get('/admin/blog-comments', middleware.admin.buildHeader, renderAdmin);
		app.get('/api/admin/blog-comments', renderAdmin);

		callback();
	};

}(module));
