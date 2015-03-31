var express = require('express')
var bodyParser = require('body-parser')
var nunjucks = require('nunjucks')
var Slack = require('node-slack')

var app = express()

// Add config module
var CONFIG = require('./services/ConfigParser')
var config = new CONFIG()

// parse application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }))

// parse application/json
app.use(bodyParser.json())

// static files
app.use('/static', express.static(__dirname + '/public'));

// templating 
nunjucks.configure('views', {
    autoescape: false,
    express: app
});

var messagesConfig = new CONFIG({filename : 'messages.json'})
var messages = messagesConfig.getConfig()
var triggers = messages.map(function(e){return e.trigger})

var slack = new Slack(config.get('domain'),config.get('api_token'))

app.get('/',function(req,res) {

    if (req.query.token != config.get('payload_token')) {

        console.log("Bad token :", req.query.token)
        res.status(403).end()

    } else {

        res.render('edit.html', {
            messages: messagesConfig.getJsonString(),
            token: req.query.token
        });
    }

})

app.post('/save/:token',function(req,res) {
    
    if (req.params.token != config.get('payload_token')) {

        console.log("Bad token :", req.params.token)
        res.status(403).end()

    } else {

        messagesConfig.writeJsonObject(req.body);
        // We need to recompute the triggers
        triggers = messagesConfig.getConfig().map(function(e){return e.trigger})
        res.end();
    }

})

app.post('/',function(req,res) {

    if (req.body.token != config.get('payload_token')) {

        console.log("Bad token :", req.body.token)
        res.status(403).end()

    } else if (req.body.user_id == 'USLACKBOT') { // Typical, for a bot.

        res.status(204).end() // No-Content

    } else {

        var reply = slack.respond(req.body,function(hook) {

            for (var i = triggers.length - 1; i >= 0; i--) {

                if (hook.text && hook.text.toLowerCase().indexOf(triggers[i]) >= 0) {

                    // Search for the correct bot — we know it exists :
                    var bot = null;
                    for (var k = 0; k < messages.length; k++) {
                        if (messages[k].trigger === triggers[i]) {
                            bot = messages[k];
                            continue;
                        }
                    };

                    // Poster
                    poster = hook.user_name

                    // Should we be specific ?
                    specifics = null 
                    for (var k = 0; k < bot.specific.length; k++) {
                        if (bot.specific[k].username === poster) {
                            specifics = bot.specific[k].messages;
                            continue;
                        }
                    };
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
                    var words = hook.text.split(/\s+/); // Split by whitespace
                    var randomWord = words[Math.floor(Math.random() * words.length)];
                    response = response.replace(/%username%/g, '@'+poster);
                    response = response.replace(/%word%/g, randomWord);

                    console.log("Responding to %s (on #%s): %s", poster, hook.channel_name, response)

                    return { 
                        text: response,
                        username: bot.username, 
                        icon_url: bot.icon_url
                    }

                } else {
                    //console.log("Didn't trigger :", triggers[i])
                }

            }
            
            
        })

        res.json(reply)
    }

});

// Start application
var server = app.listen(config.get("port"), function () {

  var host = server.address().address
  var port = server.address().port

  console.log("\n    « Beseech and thou shall hath an answer »\n")

  console.log("Available triggers :", triggers)
  console.log('Starting slack-magic-8-ball for domain %s.slack.com at http://%s:%s', config.get("domain"), host, port)

})
