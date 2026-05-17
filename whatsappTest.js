require("dotenv").config();

const twilio = require("twilio");

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

client.messages
    .create({
        from: "whatsapp:+14155238886", // your Twilio sandbox number
        to: "whatsapp:+919677423405", // your WhatsApp number
        body: "GymPro WhatsApp integration successful 🚀"
    })
    .then((message) => {
        console.log("Message Sent Successfully!");
        console.log("Message SID:", message.sid);
    })
    .catch((error) => {
        console.log("Error sending message:");
        console.log(error);
    });