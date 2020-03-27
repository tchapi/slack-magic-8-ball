console.log("\n    « Beseech and thou shall hath an answer »\n")

const serveStatic = require('serve-static')
const bodyParser = require('body-parser')
const nunjucks = require('nunjucks')
const request = require('request')
const { App, LogLevel, ExpressReceiver } = require('@slack/bolt');
const dotenv = require('dotenv');
const CONFIG = require('./services/ConfigParser')

dotenv.config()
console.log("🛠  Config read from .env file")

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver,
  logLevel: LogLevel.INFO,
  // endpoints: { // Just for reference since there is no documentation for that
  //   events: '/slack/events',
  //   commands: '/slack/events' 
  // }
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
var spell_check = generalConfig.get('spell-check');
var spell_check_users = generalConfig.get('spell-check-users');
var spell_check_ignored_categories = generalConfig.get('spell_check_ignored_categories');

console.log("  Available triggers :", triggers)

if (spell_check) {
    console.log("🔤 Spell-checking active for :", spell_check_users)
} else {
    console.log("🔤 Spell-checking inactive.")
}

receiver.app.get('/', function (req,res) {
    if (req.query.token != process.env.ACCESS_TOKEN) {
        console.log("Bad token :", req.query.token)
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
        console.log("Bad token :", req.params.token)
        res.status(403).end()
    } else {
        messagesConfig.writeJsonObject(req.body)
        // We need to recompute the triggers
        triggers = messagesConfig.getConfig().map(function(e){return e.trigger})
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
        console.log("Checking French grammar & syntax for: ", users_display_names[poster])

        var clean_text = message.text.replace(/ *\:[^:]*\: */g, " ") // remove smileys, emoticons
            clean_text = clean_text.replace(/ *\`\`\`[^:]*\`\`\` */g, " ") // remove code

        request.post(
            'https://languagetool.org/api/v2/check',
            { 'form' : {'language' : 'fr', 'text': clean_text, 'disabledRules': generalConfig.get('spell_check_ignored_rules').join()} },
            function (error, response, body) {

                result = JSON.parse(body)

                if (!error && response.statusCode == 200) {
                    if (result.matches.length > 0) {
                        var nb_errors = result.matches.length

                        for (var k = 0; k < nb_errors; k++) {
                            var ob = result.matches[k]

                            // We ignore some categories
                            if (spell_check_ignored_categories.indexOf(ob.rule.category.id) >= 0) {
                                continue;
                            }

                            response = "> ... " + clean_text.substring(ob.offset, ob.offset + ob['length']) + " ..." + "\n" + "_(<@" + poster + ">, " + ob.message.toLowerCase() + /*" — " + ob.ruleId +*/")_"
                            console.log("Triggered Rule ID : %s (Category : %s)", ob.rule.id, ob.rule.category.id)

                            responseObject = {
                                text: response,
                                username: generalConfig.get('spell_check_bot_username'), 
                                icon_url: generalConfig.get('spell_check_icon_url'),
                            }
                            break
                        }
                    }
                }
            }
        )
    }

    if (responseObject) {
        // Post a message if needed
        console.log(`Responding to ${users_display_names[poster]} (on #{message.channel}):`)
        console.log(responseObject)
        try {
            // const result = await app.client.chat.postMessage({
            //   token: process.env.SLACK_BOT_TOKEN,
            //   channel: message.channel,
            //   text: responseObject.text,
            //   username: responseObject.username,
            //   icon_url: responseObject.icon_url
            // });
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
