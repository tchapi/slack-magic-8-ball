var express = require('express')
var bodyParser = require('body-parser')
var nunjucks = require('nunjucks')
var Slack = require('node-slack')

var request = require('request')
var parseString = require('xml2js').parseString

var app = express()

// Add config module
var CONFIG = require('./services/ConfigParser')
var config = new CONFIG()

// parse application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }))

// parse application/json
app.use(bodyParser.json())

// static files
app.use('/static', express.static(__dirname + '/public'))

// templating 
nunjucks.configure('views', {
    autoescape: false,
    express: app
})

var messagesConfig = new CONFIG({filename : 'messages.json'})
var messages = messagesConfig.getConfig()
var triggers = messages.map(function(e){return e.trigger})

var generalConfig = new CONFIG({filename : 'general.json'})
var spell_check = generalConfig.get('spell-check')
var spell_check_users = generalConfig.get('spell-check-users')

var slack = new Slack(config.get('domain'),config.get('api_token'))

app.get('/',function(req,res) {

    if (req.query.token != config.get('payload_token')) {

        console.log("Bad token :", req.query.token)
        res.status(403).end()

    } else {

        res.render('edit.html', {
            messages: messagesConfig.getJsonString(),
            token: req.query.token
        })
    }

})

app.post('/save/:token',function(req,res) {
    
    if (req.params.token != config.get('payload_token')) {

        console.log("Bad token :", req.params.token)
        res.status(403).end()

    } else {

        messagesConfig.writeJsonObject(req.body)
        // We need to recompute the triggers
        triggers = messagesConfig.getConfig().map(function(e){return e.trigger})
        res.end()
    }

})

app.post('/',function(req,res) {

    if (req.body.token != config.get('payload_token')) {

        console.log("Bad token :", req.body.token)
        res.status(403).end()

    } else if (req.body.user_id == 'USLACKBOT') { // Typical, for a bot.

        res.status(204).end() // No-Content

    } else {

        var hook = req.body

        // Poster
        poster = hook.user_name

        for (var i = triggers.length - 1; i >= 0; i--) {

            if (hook.text && hook.text.toLowerCase().indexOf(triggers[i]) >= 0) {

                // Search for the correct bot — we know it exists :
                var bot = null;
                for (var k = 0; k < messages.length; k++) {
                    if (messages[k].trigger === triggers[i]) {
                        bot = messages[k]
                        continue
                    }
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
                var words = hook.text.split(/\s+/) // Split by whitespace
                var randomWord = words[Math.floor(Math.random() * words.length)]
                response = response.replace(/%username%/g, '@'+poster)
                response = response.replace(/%word%/g, randomWord)

                console.log("Responding to %s (on #%s): %s", poster, hook.channel_name, response)

                res.json({ 
                    text: response,
                    username: bot.username, 
                    icon_url: bot.icon_url
                })
                return

            }

        }

        //console.log("Didn't trigger :", hook.text)

        // No triggers were found, should we spell-check ?
        if (hook.text && spell_check && spell_check_users.indexOf(poster) >= 0) {
            console.log("Checking French grammar & syntax for :", poster)

            var clean_text = hook.text.replace(/ *\:[^:]*\: */g, " ")

            request.post(
                'https://languagetool.org:8081',
                { 'form' : {'language' : 'fr', 'text': clean_text, 'disabled': "UPPERCASE_SENTENCE_START,HUNSPELL_NO_SUGGEST_RULE,FRENCH_WHITESPACE"} },
                function (error, response, body) {
                    if (!error && response.statusCode == 200) {

                        parseString(body, function (err, result) {
                            if (result.matches.error && result.matches.error.length > 0) {
                                var nb_errors = result.matches.error.length

                                for (var k = 0; k < nb_errors; k++) {
                                    var ob = result.matches.error[k]['$']
                                    response = "> ... " + clean_text.substring(ob.fromx, ob.tox) + " ..." + "\n" + "— <@" + poster + ">\n" + "_(<@" + poster + ">, " + ob.msg.toLowerCase() + /*" — " + ob.ruleId +*/")_"
                                    console.log("Triggered Rule ID : %s (Category : %s)", ob.ruleId, ob.categoryid)
                                    console.log("Responding to %s (on #%s): %s", poster, hook.channel_name, response)

                                    res.json({ 
                                        text: response,
                                        username: generalConfig.get('spell_check_bot_username'), 
                                        icon_url: generalConfig.get('spell_check_icon_url'),
                                    })
                                    return

                                }

                            } else {
                                //console.log("Spell-check was correct for :", hook.text)
                                res.json({})
                                return
                            }
                        })
                    } else {
                        //console.log("There has been an error processing the request :", body)
                        res.json({})
                        return
                    }
                }
            )

        } else {
            //console.log("Really nothing to do :", hook.text)
            res.json({})
            return
        }
        
    }

});

// Start application
var server = app.listen(config.get("port"), function () {

  var host = server.address().address
  var port = server.address().port

  console.log("\n    « Beseech and thou shall hath an answer »\n")

  console.log("Available triggers :", triggers)
  if (spell_check) {
    console.log("Spell-checking active for :", spell_check_users)
  } else {
    console.log("Spell-checking inactive.")
  }
  console.log('Starting slack-magic-8-ball for domain %s.slack.com at http://%s:%s', config.get("domain"), host, port)

})
