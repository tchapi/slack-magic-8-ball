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
console.log('🛠  Config read from .env file')

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver,
  logLevel: LogLevel.INFO
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

var messagesConfig = new CONFIG({filename : 'messages.json'});
var messages = messagesConfig.getConfig();
var triggers = messages.map(function(e){return e.trigger});

var generalConfig = new CONFIG({filename : 'general.json'});
var users_display_names = generalConfig.get('users-display-names');
var channels_display_names = generalConfig.get('channels-display-names');
var spell_check = generalConfig.get('spell-check');
var spell_check_users = generalConfig.get('spell-check-users');
var spell_check_ignored_categories = generalConfig.get('spell_check_ignored_categories');

console.log('🧰 Available triggers:', triggers)

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

    for (var i = triggers.length - 1; i >= 0; i--) {

        if (message.text && message.text.toLowerCase().indexOf(triggers[i]) >= 0) {

            // Search for the correct bot — we know it exists:
            var bot = null;
            for (var k = 0; k < messages.length; k++) {
                if (messages[k].trigger === triggers[i]) {
                    bot = messages[k]
                    continue
                }
            }

            if (bot === null) {
                continue
            }

            // Should we be specific ?
            specifics = null 
            for (var k = 0; k < bot.specific.length; k++) {
                if (bot.specific[k].username === poster) {
                    specifics = bot.specific[k].messages
                    continue
                }
            }
            specific = Math.random() < 0.1 ? (specifics !== null && specifics.length > 0): false
            if (specific) {
                response = specifics[Math.floor(Math.random() * specifics.length)]
            } else {
                response = bot.general[Math.floor(Math.random() * bot.general.length)]
            }

            // Replace placeholders
            /*
                Currently supported :
                %username% => user_name
                %word% => a random word from the original post
            */
            var words = message.text.split(/\s+/) // Split by whitespace
            response = response.replace(/%username%/g, '<@' + poster + '>')

            if (words.length > 2) {
                var randomWord = words[Math.floor(Math.random() * words.length)]
                response = response.replace(/%word%/g, randomWord)
            } else {
                response = response.replace(/%word%/g, '<@' + poster + '>') // Dirty fallback but we have nothing else
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

        var clean_text = message.text.replace(/ *\:[^:]*\: */g, " ") // remove smileys, emoticons
            clean_text = clean_text.replace(/ *\`\`\`[^:]*\`\`\` */g, " ") // remove code


        const params = new URLSearchParams();
        params.append('language', 'fr');
        params.append('text', clean_text);
        params.append('disabledRules', generalConfig.get('spell_check_ignored_rules').join());

        try {
            const response = await fetch('https://languagetool.org/api/v2/check', { method: 'POST', body: params });
            const result = await response.json();
            
            if (result.matches.length > 0) {
                var nb_errors = result.matches.length

                for (var k = 0; k < nb_errors; k++) {
                    var ob = result.matches[k]

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
        console.log(`💬 Responding to ${users_display_names[poster] || poster} (on ${channels_display_names[message.channel] || message.channel}):`)
        console.log(responseObject)
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
