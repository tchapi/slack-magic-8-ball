console.log(`\n    « Beseech and thou shall hath an answer »\n`)

const serveStatic = require('serve-static')
const bodyParser = require('body-parser')
const nunjucks = require('nunjucks')
const fetch = require('node-fetch')
const { URLSearchParams } = require('url')
const { App, LogLevel, ExpressReceiver } = require('@slack/bolt')
const dotenv = require('dotenv')
const CONFIG = require('./services/ConfigParser')

dotenv.config()

if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_SIGNING_SECRET || !process.env.ACCESS_TOKEN) {
    console.error('Error: You must provide a SLACK_BOT_TOKEN, a SLACK_SIGNING_SECRET and an ACCESS_TOKEN in your .env file.')
    return
}

console.log('🛠  Config read from .env file')

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver,
//   logLevel: LogLevel.INFO
});

receiver.app.use(bodyParser.urlencoded({ extended: false }))
receiver.app.use(bodyParser.json())

// static files
receiver.app.use('/static', serveStatic(__dirname + '/public'))

// templating 
nunjucks.configure('views', {
    autoescape: false,
    express: receiver.app
})

let messagesConfig = new CONFIG({filename : 'messages.json'});
let messages = messagesConfig.getConfig();

const generalConfig = new CONFIG({filename : 'general.json'});
const triggers_per_channel = generalConfig.get('authorized-triggers-per-channels');
const users_display_names = generalConfig.get('users-display-names');
const channels_display_names = generalConfig.get('channels-display-names');
const spell_check = generalConfig.get('spell-check');
const spell_check_users = generalConfig.get('spell-check-users');
const spell_check_ignored_categories = generalConfig.get('spell_check_ignored_categories');

for (const channel_id in triggers_per_channel) {
    console.log(`🧰 Available triggers for channel ${channels_display_names[channel_id]}:`, triggers_per_channel[channel_id]);
}

if (spell_check) {
    console.log('🔤 Spell-checking active for:', spell_check_users)
} else {
    console.log('🔤 Spell-checking inactive.')
}

receiver.app.get('/', function (req,res) {
    if (req.query.token != process.env.ACCESS_TOKEN) {
        console.log(`Bad token ${req.params.token}`)
        res.status(403).end()
    } else {
        res.render('edit.html', {
            messages: messagesConfig.getJsonString(),
            token: req.query.token
        })
    }
});

receiver.app.post('/save/:token', function (req,res) {
    if (req.params.token != process.env.ACCESS_TOKEN) {
        console.log(`Bad token ${req.params.token}`)
        res.status(403).end()
    } else {
        messagesConfig.writeJsonObject(req.body)
        // We need to recompute the triggers
        triggers = messagesConfig.getConfig().map(e => e.trigger)
        res.end()
    }
});

app.message(async ({ message }) => {

    let responseObject = null;

    // Poster
    poster = message.user

    // Retrieve available triggers for the channel the message was posted to
    const triggers = triggers_per_channel[message.channel];

    if (!triggers) {
        return
    }

    for (let i = triggers.length - 1; i >= 0; i--) {

        if (message.text && message.text.toLowerCase().indexOf(triggers[i]) >= 0) {

            // Search for the correct bot — we know it exists:
            let bot = null;
            searchBot: for (let k = 0; k < messages.length; k++) {
                if (messages[k].trigger === triggers[i]) {
                    bot = messages[k]
                    break searchBot
                }
            }

            if (bot === null) {
                continue
            }

            // Do we have answers ?
            answers = null
            isInterrogative = message.text.indexOf('?') >= 0
            searchAnswers: for (let r = 0; r < bot.answers.length; r++) {
                // If the message contains one of the keyword
                for (var w of bot.answers[r].keywords) {
                    const mustBeInterrogative = bot.answers[r].mustBeInterrogative
                    if (answers === null && message.text.toLowerCase().indexOf(w) >= 0 && (mustBeInterrogative === null || (isInterrogative === mustBeInterrogative))) {
                        // Choose a random answer
                        answers = bot.answers[r].answers
                        break searchAnswers
                    }
                }
            }

            if (answers) {
                response = answers[Math.floor(Math.random() * answers.length)]
            } else {
                // Do we have specifics ?
                specifics = null 
                searchSpecifics: for (let k = 0; k < bot.specific.length; k++) {
                    if (bot.specific[k].username === poster) {
                        specifics = bot.specific[k].messages
                        break searchSpecifics
                    }
                }

                // _Should_ it be specific ?
                specific = Math.random() < 0.1 ? (specifics !== null && specifics.length > 0): false

                if (specific) {
                    response = specifics[Math.floor(Math.random() * specifics.length)]
                } else {
                    response = bot.general[Math.floor(Math.random() * bot.general.length)]
                }
            }

            // Replace placeholders
            /*
                Currently supported :
                %username% => user_name
                %word% => a random word from the original post
                %random_article% => a random Wikipedia article
                %random_int% => a formatted random int between 1 and 1000
            */
            let words = message.text.split(/\s+/) // Split by whitespace
            // Only retain words of more than 3 characters
            words = words.filter(x => x.length > 2)
            response = response.replace(/%username%/g, '<@' + poster + '>')

            if (words.length > 2) {
                const randomWord = words[Math.floor(Math.random() * words.length)]
                response = response.replace(/%word%/g, randomWord)
            } else {
                response = response.replace(/%word%/g, '<@' + poster + '>') // Dirty fallback but we have nothing else
            }

            response = response.replace(/%random_int%/g, new Intl.NumberFormat().format(10 * Math.floor(Math.random() * 100) + 1))
            
            if (response.toLowerCase().indexOf('%random_article%') >= 0) {
                const wikimedia_article = await fetch('https://fr.wikipedia.org/wiki/Special:Random')
                if (wikimedia_article.url) {
                    response = response.replace(/%random_article%/g, wikimedia_article.url)
                } else {
                    response = response.replace(/%random_article%/g, "https://perdu.com")
                }
            }

            responseObject = {
                text: response,
                username: bot.username, 
                icon_url: bot.icon_url
            }
        }
    }

    // No triggers were found, should we spell-check ?
    if (!responseObject && message.text && spell_check && spell_check_users.indexOf(poster) >= 0) {
        console.log(`Checking French grammar & syntax for: ${users_display_names[poster]}`)

        const clean_text = message.text.replace(/ *\:[^:]*\: */g, " ") // remove smileys, emoticons
                                       .replace(/ *\`\`\`[^:]*\`\`\` */g, " ") // remove code


        const params = new URLSearchParams();
        params.append('language', 'fr');
        params.append('text', clean_text);
        params.append('disabledRules', generalConfig.get('spell_check_ignored_rules').join());

        try {
            const response = await fetch('https://languagetool.org/api/v2/check', { method: 'POST', body: params });
            const result = await response.json();
            
            if (result.matches.length > 0) {
                const nb_errors = result.matches.length

                for (let k = 0; k < nb_errors; k++) {
                    let ob = result.matches[k]

                    // We ignore some categories
                    if (spell_check_ignored_categories.indexOf(ob.rule.category.id) >= 0) {
                        continue;
                    }

                    text = '> ... ' + clean_text.substring(ob.offset, ob.offset + ob['length']) + ' ...' + '\n' + '_(<@' + poster + '>, ' + ob.message.toLowerCase() + /*' — ' + ob.ruleId +*/')_'
                    console.log(`Triggered Rule ID: ${ob.rule.id} (Category: ${ob.rule.category.id})`)

                    responseObject = {
                        text: text,
                        username: generalConfig.get('spell_check_bot_username'), 
                        icon_url: generalConfig.get('spell_check_icon_url'),
                    }
                    break
                }
            }
        } catch (error) {
            console.log(error);
        }
    }

    if (responseObject) {
        // Post a message if needed
        console.log(`💬 Responding to ${users_display_names[poster] || poster} (on ${channels_display_names[message.channel] || message.channel}): ${responseObject.text}`)
        try {
            const result = await app.client.chat.postMessage({
              token: process.env.SLACK_BOT_TOKEN,
              channel: message.channel,
              text: responseObject.text,
              username: responseObject.username,
              icon_url: responseObject.icon_url
            });
        }
        catch (error) {
            console.error(error);
        }
    }
});

(async () => {
  const port = process.env.PORT || 4000
  await app.start(port);

  console.log(`⚡️ Starting slack-magic-8-ball on port ${port}`)
})();
