/* eslint-disable no-unused-expressions */
/* eslint-disable camelcase */
/* eslint-disable no-unused-vars */
;(function (module) {
  'use strict'
  const Telegram = {}

  const db = require.main.require('./src/database')
  const meta = require.main.require('./src/meta')
  const user = require.main.require('./src/user')
  const posts = require.main.require('./src/posts')
  const Topics = require.main.require('./src/topics')
  const Categories = require.main.require('./src/categories')
  const messaging = require.main.require('./src/messaging')
  const SocketPlugins = require.main.require('./src/socket.io/plugins')
  const winston = require.main.require('winston')
  const nconf = require.main.require('nconf')
  const async = require.main.require('async')
  const S = require('string')
  const Cache = require('lru-cache')
  let lang_cache
  const translator = require.main.require('./public/src/modules/translator')
  const moment = require('moment')
  const pubsub = require.main.require('./src/pubsub')
  const privileges = require.main.require('./src/privileges')
  // const NodeBBConfig = require.main.require('./config.json')

  const Settings = require('./lib/userSettings.js')(Telegram)
  //   SocketAdmins = module.parent.require('./socket.io/admin');

  const Promise = require('bluebird')
  Promise.config({
    cancellation: true,
  })
  const TelegramBot = require('node-telegram-bot-api')

  let bot = null
  let token = null
  let message = null
  let messageQueue = {}
  const plugin = {
    config: {
      telegramid: '',
      chatid: '',
      roomId: '',
      maxLength: '',
      postCategories: '',
      topicsOnly: '',
      messageContent: '',
    },
  }

  Telegram.init = function (params, callback) {
    const middleware = params.middleware
    const controllers = params.controllers

    // Prepare templates
    controllers.getTelegramBotAdmin = function (req, res, next) {
      // Renders template (*Renderiza la plantilla)
      res.render('admin/plugins/telegrambot', {})
    }
    // prepare parameter and start the bot
    controllers.getTelegramBotSettings = function (req, res, next) {
      // Renders template (*Renderiza la plantilla)
      pubsub.on('telegram:me', function (me) {
        res.render('user/settings', { botname: me.username })
      })
      pubsub.publish('telegram:getMe')
    }

    // Create urls
    params.router.get(
      '/admin/telegrambot',
      middleware.buildHeader,
      controllers.getTelegramBotAdmin,
    )
    params.router.get('/api/admin/telegrambot', controllers.getTelegramBotAdmin)
    params.router.get(
      '/telegram/settings',
      Telegram.isLoggedIn,
      middleware.buildHeader,
      controllers.getTelegramBotSettings,
    )
    params.router.get(
      '/api/telegram/settings',
      Telegram.isLoggedIn,
      controllers.getTelegramBotSettings,
    )

    // User language cache
    db.getObjectField('global', 'userCount', function (err, numUsers) {
      if (err) {
        window.error(err)
        process.exit(1)
      }

      var cacheOpts = {
        max: 50,
        maxAge: 1000 * 60 * 60 * 24,
      }

      if (!err && numUsers > 0) {
        cacheOpts.max = Math.floor(numUsers / 20)
      }
      lang_cache = new Cache(cacheOpts)
    })

    // get settings
    meta.settings.get('telegram-notification', function (err, settings) {
      if (err) {
        window.error(err)
        process.exit(1)
      }
      winston.verbose(JSON.stringify(settings, null, 2))
      for (var prop in plugin.config) {
        if (settings[prop]) {
          plugin.config[prop] = settings[prop]
        }
      }
      token = plugin.config.telegramid

      // Start the bot only on the primary instance and if a bot token is configured
      // console.log(nconf.get('isPrimary'))
      // console.log(nconf.get('jobsDisabled'))
      // console.log(global.telegram)
      // console.log(token)
      if (
        nconf.get('isPrimary') === true &&
        !nconf.get('jobsDisabled') &&
        !global.telegram &&
        token
      ) {
        startBot()
      } else {
        // at least get token in all instances to prepare&show menus
        // db.getObject('telegrambot-token', function(err, t)
        // {
        // if(err || !t)
        // {
        // return;
        // }

        message = plugin.config.messagecontent
        // });
      }
    })

    callback()
  }

  function startBot() {
    // Prepare bot
    winston.info(
      '[telegram-notification] Starting bot. Please DO NOT do anythig.',
    )
    messageQueue = {}
    winston.verbose('Token: ' + token)

    // Setup polling way
    bot = new TelegramBot(token, { polling: true })
    // console.log(bot)
    global.telegram = bot

    // debug use
    // bot.on('message', (msg) => {
    //  console.log(msg)
    // })

    bot.on('text', function (msg) {
      var chatId = msg.chat.id
      var userId = msg.from.id
      var username = msg.from.username
      var text = msg.text
      if (plugin.config.chatid === '') {
        plugin.config.chatid = chatId
      }

      if (!message) {
        message =
          '\n Hello this is the ForumBot\n\n' +
          'I am your interface to your ' +
          'NodeBB Forum\n\n' +
          'Your Telegram ID: {userid}\n' +
          'ID of this chat:<b> ' +
          msg.chat.id +
          '</b>\n' +
          'Open a chat with me and type /bothelp to see, what I can do for you\n' +
          "You even may enter commands here: like '/<command> <parameters>@forumbot', " +
          'but I always ill answer in private chat only'
      }
      if (text.toLowerCase().indexOf('@forumbot') >= 3) {
        var text2 = text.split('@forumbot') // remove the @forumbot, that should be at the end of the command
        text = text2.join(' ') // recover the command

        if (text.indexOf('/') === 0) {
          parseCommands(userId, text)
        }
      } else {
        //     if (msg.text == "@ForumBot")
        if (text.toLowerCase() === '@forumbot') {
          var messageToSend = message.replace('{userid}', msg.from.id)
          bot.sendMessage(msg.chat.id, messageToSend)
        }
      }
    })

    // Notification observer.
    pubsub.on('telegram:notification', function (data) {
      bot.sendMessage(data.telegramId, data.message).catch(function () {})
    })

    // Settings observer.
    pubsub.on('telegram:getMe', function () {
      bot
        .getMe()
        .then(function (me) {
          pubsub.publish('telegram:me', me)
        })
        .catch(function () {})
    })
  } // function startbot

  var parseCommands = function (telegramId, mesg) {
    function respond(response) {
      pubsub.publish('telegram:notification', {
        telegramId: telegramId,
        message: response,
      })
    }

    function respondWithTranslation(uid, response) {
      Telegram.getUserLanguage(uid, function (lang) {
        translator.translate(response, lang, function (translated) {
          respond(translated)
        })
      })
    }

    if (mesg.indexOf('/') === 0) {
      db.sortedSetScore('telegramid:uid', telegramId, function (err, uid) {
        if (err || !uid) {
          return respond(
            'UserID not found.. Put your TelegramID again in the telegram settings of the forum. :(',
          )
        }
        mesg = mesg.replace(',', ' ') // the client may insert a "," after the first word of the input
        var command = mesg.split(' ') // Split command
        if (command[0].toLowerCase() === '/r' && command.length >= 3) {
          // It's a reply to a topic!
          var data = {}
          data.uid = uid
          data.tid = command[1]
          command.splice(0, 2) // Delete /r and topic id, only keep the message
          data.content = command.join(' ') // recover the message

          if (messageQueue[data.uid]) {
            // check queue to avoid race conditions and flood with many posts
            // Get user language to send the error
            respondWithTranslation(uid, '[[error:too-many-messages]]')
            return
          }

          // update queue
          messageQueue[data.uid] = true

          Topics.reply(data, function (err, postData) {
            delete messageQueue[data.uid]
            if (err) {
              // Get user language to send the error
              respondWithTranslation(uid, err.message)
              return
            }
            respondWithTranslation(uid, '[[success:topic-post]]')
          })
          // eslint-disable-next-line brace-style
        } else if (command[0].toLowerCase() === '/recent') {
          /* chat command kills nodebb, so disable it until it's fixed
*
      else if(command[0].toLowerCase() == "/chat" && command.length >= 3)
      {// It's a reply to a topic!
        var data = {};
        user.getUidByUserslug(command[1], function(err, touid){
          if(err || !touid)
          {
            return respond("Error: UserID "+command[1]+" not found);
          }
          data.fromuid = uid;
          command.splice(0, 2); // Delete /chat and username, only keep the message
          data.content = command.join(" "); // recover the message
          messaging.addMessage(uid, touid, data.content, function(err, r){
            if(err)
            {
              respond("Error..");
            }
            else
            {
              respondWithTranslation(uid, "[[success:success]]");
            }
          });
        });
      }
*/
          data = {}
          var numtopics = command[1] || 10
          numtopics = Math.min(30, numtopics)
          Topics.getTopicsFromSet(
            'topics:recent',
            uid,
            0,
            Math.max(1, numtopics),
            function (err, topics) {
              if (err) {
                return respond('[[error:no-recent-topics]]')
              }

              var response = ''
              topics = topics.topics

              for (var i in topics) {
                var title = topics[i].title
                var tid = topics[i].tid
                var user = topics[i].user.username
                var time = moment.unix(topics[i].lastposttime / 1000).fromNow()
                var url = nconf.get('url') + '/topic/' + tid
                response +=
                  title + ' ' + time + ' by ' + user + '\n' + url + '\n\n'
              }

              respond(response)
            },
          )
        } else if (
          command[0].toLowerCase() === '/read' &&
          command.length >= 2
        ) {
          data = {}
          var tid = command[1]
          privileges.topics.get(tid, uid, function (err, data) {
            if (err) {
              winston.error(err)
              return respond(err.message)
            }
            var canRead = data['topics:read']

            if (!canRead) {
              return respondWithTranslation(uid, '[[error:no-privileges]]')
            }

            Topics.getPids(tid, function (err, pids) {
              if (err) {
                winston.error(err)
                return respond(err.message)
              }
              posts.getPostsByPids(pids, uid, function (err, posts) {
                if (err) {
                  winston.error(err)
                  return respond('[[error:no-posts-for-topic]]')
                }

                var postsuids = []

                for (var i in posts) {
                  postsuids.push(posts[i].uid)
                }

                user.getUsersFields(postsuids, ['username'], function (
                  err,
                  usernames,
                ) {
                  if (err) {
                    winston.error(err)
                    return respond(err.message)
                  }
                  var response = ''
                  var numPosts = 10
                  var start =
                    posts.length - numPosts > 0 ? posts.length - numPosts : 0
                  for (var i = start; i < posts.length; i++) {
                    var username = usernames[i].username
                    var content = posts[i].content
                    // eslint-disable-next-line no-useless-escape
                    content = content.replace(/\<[^\>]*\>/gi, '')
                    var tid = posts[i].tid
                    var time = moment.unix(posts[i].timestamp / 1000).fromNow()
                    response =
                      content + ' \n ' + time + ' by ' + username + '\n\n'

                    respond(response)
                  }
                })
              })
            })
          })
        } else if (command[0].toLowerCase() === '/bothelp') {
          var response =
            'I understand the following commands:\n' +
            '/recent [<number>]\t- list recent <number> posts.  (Default = 10)\n' +
            '/r \t\t\t<TopicId>  \t- respond to forum topic <TopicId>\n' +
            '/read \t\t <TopicId> \t- read latest posts form Topic <TopicId>\n'
          respond(response)
        } else
          respond("[[Sorry, I don't understand]] " + command + ' [[try again]]')
      })
    }
  }

  Telegram.postSave = (post) => {
    winston.verbose(JSON.stringify(post, null, 2))
    post = post.post
    var roomId = plugin.config.roomId
    var topicsOnly = plugin.config.topicsOnly || 'off'
    if (topicsOnly === 'off' || (topicsOnly === 'on' && post.isMain)) {
      var content = post.content

      async.parallel(
        {
          user: function (callback) {
            user.getUserFields(post.uid, ['username', 'picture'], callback)
          },
          topic: function (callback) {
            Topics.getTopicFields(post.tid, ['title', 'slug'], callback)
          },
          category: function (callback) {
            Categories.getCategoryFields(
              post.cid,
              ['name', 'bgColor'],
              callback,
            )
          },
          tags: function (callback) {
            Topics.getTopicTags(post.tid, callback)
          },
        },
        function (err, data) {
          if (err) {
            winston.error(err)
            return
          }
          if (plugin.config.postCategories === '') {
            winston.error('[telegram-notification] Categroies is not set!')
            return
          }
          let categories
          try {
            categories = JSON.parse(plugin.config.postCategories)
          } catch (err) {
            winston.error(plugin.config.postCategories)
            winston.error(
              "[telegram-notification] Categroies can't be parsed. Could you configure correctly?",
            )
          }
          if (!categories || categories.indexOf(String(post.cid)) >= 0) {
            // 预处理，提取图片
            let imgUrl
            if (!/!\[(.*)\]\((.*)\)/.test(content)) {
              imgUrl = ''
            } else {
              const regex = /!\[(.*?)\]\((.*?)\)/g
              imgUrl = content.match(regex)[0].match(/\((.*)\)/)[1]
              content = content.replace(/!\[(.*?)\]\((.*?)\) *\n?/g, '') // 去除图片标记
            }

            // Trim long posts:
            var maxQuoteLength = plugin.config.maxLength || 1024
            if (content.length > maxQuoteLength) {
              // 截取最大长度
              content = content.substring(0, maxQuoteLength) + '……'
            }
            // Ensure absolute thumbnail URL:
            // TODO: 搞清楚要做什么
            // var thumbnail = data.user.picture.match(/^\//) ? NodeBBConfig.url + data.user.picture : data.user.picture
            winston.verbose(JSON.stringify(data, null, 2))
            // Add custom message:

            // 这里是发信文本，定制请走这里
            const topicUrl =
              nconf.get('url') + '/topic/' + data.topic.slug + '/'
            let messageContent = `【 #${data.category.name} 】@${data.user.username} [${data.topic.title}](${topicUrl})\n`
            messageContent += content
            if (data.tags && data.tags.length > 0) {
              messageContent += messageContent.endsWith('\n') ? '\n' : '\n\n'
              data.tags.forEach((tag) => {
                messageContent += `#${tag} `
              })
            }
            //           messageContent = S(messageContent).unescapeHTML().stripTags().unescapeHTML().s

            /*
          // Make the rich embed:
          var embed = new Discord.RichEmbed()
            .setColor(data.category.bgColor)
            .setURL(forumURL + '/topic/' + data.topic.slug)
            .setTitle(data.category.name + ': ' + data.topic.title)
            .setDescription(content)
            .setFooter(data.user.username, thumbnail)
            .setTimestamp();
*/
            // Send notification:
            if (bot) {
              winston.verbose('[telegram-notification] Used Chat Id: ' + roomId)
              if (imgUrl !== '' && imgUrl) {
                bot
                  .sendPhoto(roomId, imgUrl, {
                    caption: messageContent,
                    parse_mode: 'Markdown',
                  })
                  .catch(console.error)
              } else {
                bot
                  .sendMessage(roomId, messageContent, {
                    parse_mode: 'Markdown',
                  })
                  .catch(console.error)
              }
            } else {
              winston.error('Telegram: No bot found:')
            }
          }
        },
      )
    }
  }

  Telegram.getUserLanguage = function (uid, callback) {
    if (lang_cache && lang_cache.has(uid)) {
      callback(null, lang_cache.get(uid))
    } else {
      user.getSettings(uid, function (err, settings) {
        if (err) {
          return callback(err)
        }
        var language = settings.language || meta.config.defaultLang || 'en_GB'
        callback(null, language)
        lang_cache.set(uid, language)
      })
    }
  }

  /* changed notification mechanism
   * Users need to join the configured Telegram room now in order to be notified,
   * as there may be non- forum members on telegram.
   * the method below can be enabled again to provide additional notifications to
   * forum users with configured telegram ID
   */
  Telegram.pushNotification = function (data, callback) {
    var notifObj = data.notification
    var uids = data.uids
    winston.info('pushNotification:\n')
    console.log(notifObj)

    if (!Array.isArray(uids) || !uids.length || !notifObj) {
      return callback(
        new Error(
          '触发错误：!Array.isArray(uids) || !uids.length || !notifObj',
        ),
      )
    }

    if (notifObj.nid && notifObj.nid.indexOf('post_flag') > -1) {
      // Disable notifications from flags.
      return callback(
        new Error(
          '触发错误：notifObj.nid && notifObj.nid.indexOf("post_flag") > -1',
        ),
      )
    }

    // Send notification for each user.
    user.getUsersFields(uids, ['telegramid'], function (err, usersData) {
      if (err) {
        winston.error(err)
        return callback(err)
      }
      async.eachSeries(usersData, function iterator(user, cb) {
        var telegramId = user.telegramid
        var uid = user.uid

        async.waterfall([
          function (next) {
            // Get user language
            Telegram.getUserLanguage(uid, next)
          },
          function (lang, next) {
            // Prepare notification with the user language
            notifObj.bodyLong = notifObj.bodyLong || ''
            notifObj.bodyLong = S(notifObj.bodyLong)
              .unescapeHTML()
              .stripTags()
              .unescapeHTML().s
            async.parallel(
              {
                title: function (next) {
                  translator.translate(notifObj.bodyShort, lang, function (
                    translated,
                  ) {
                    next(undefined, S(translated).stripTags().s)
                  })
                },
                postIndex: async.apply(
                  posts.getPidIndex,
                  notifObj.pid,
                  notifObj.tid,
                  '',
                ),
                topicSlug: async.apply(
                  Topics.getTopicFieldByPid,
                  'slug',
                  notifObj.pid,
                ),
              },
              next,
            )
          },
          function (data, next) {
            // Send notification
            var title = data.title
            var url = nconf.get('url') + notifObj.path
            var body = title + '\n\n' + notifObj.bodyLong + '\n\n' + url

            winston.verbose(
              '[plugins/telegram] Sending notification to uid ' + uid,
            )
            pubsub.publish('telegram:notification', {
              telegramId: telegramId,
              message: body,
            })

            cb() // Go next user in array (async.eachSeries)
          },
        ])
      })
    })
  }
  /**/

  Telegram.addNavigation = function (custom_header, callback) {
    // Adding to admin menu access to see logs (*Añadimos al menu de admin el acceso a ver los registros)
    custom_header.plugins.push({
      route: '/telegrambot',
      icon: '',
      name: 'Telegram Notifications',
    })

    callback(null, custom_header)
  }

  Telegram.isLoggedIn = function (req, res, next) {
    // Check if user is logged in (for middleware)
    if (req.user && parseInt(req.user.uid, 10) > 0) {
      next()
    } else {
      res.redirect('403')
    }
  }

  module.exports = Telegram
})(module)
