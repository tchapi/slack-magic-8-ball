var express = require('express')
var bodyParser = require('body-parser')
var Slack = require('node-slack');
var app = express()

// Add config module
var CONFIG = require('./services/ConfigParser')
var config = new CONFIG()

// parse application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }))

// parse application/json
app.use(bodyParser.json())

var messages = require('./messages')
    messages = messages["messages"]
var triggers = Object.keys(messages)

var slack = new Slack(config.get('domain'),config.get('api_token'))

app.get('/',function(req,res) {
    res.status(200).send("« Beseech and thou shall hath an answer »")
})

app.post('/',function(req,res) {

    if (req.body.token != config.get('payload_token')) {

        console.log("Bad token :", req.token)
        res.status(403).end()

    } else if (req.body.user_id == 'USLACKBOT') { // Typical, for a bot.

        res.status(204).end() // No-Content

    } else {

        var reply = slack.respond(req.body,function(hook) {

            for (var i = triggers.length - 1; i >= 0; i--) {

                if(hook.text.indexOf(triggers[i]) >= 0) {

                    // Our available responses
                    available_responses = messages[triggers[i]]
                    // Poster
                    poster = hook.user_name

                    // Should we be specific ? 
                    specific = Math.random() < 0.1 ? (poster in available_responses.specific && available_responses.specific[poster].length > 0): false
                    if (specific) { // Yes
                        response = available_responses.specific[poster][Math.floor(Math.random() * available_responses.specific[poster].length)]
                    } else {
                        response = available_responses.general[Math.floor(Math.random() * available_responses.general.length)]
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
                        username: available_responses.username, 
                        icon_url: available_responses.icon_url
                    }

                } else {
                    console.log("Didn't trigger :", triggers[i])
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
