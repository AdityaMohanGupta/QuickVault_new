const express = require('express');
const app = express();
const path = require('path');
// const methodOverride = require('method-override');
// const passport =require('passport');
// const { Strategy } =require('passport-google-oauth20');
// const cookieSession=require('cookie-session');
// const mongoose = require('mongoose');
// const jwt = require('jsonwebtoken');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
// const { Storage } = require('@google-cloud/storage');
const { google } = require('googleapis');
require('dotenv').config();
const apikeys = require("./apikeys.json");
const os = require("os");



// app.use(passport.initialize());
// app.use(passport.session());
// app.use(cookieParser());
// app.set('view engine' , 'ejs');
// app.set('views' , path.join(__dirname , 'views'));
// app.set('trust proxy', true);
// app.use(express.static(path.join(__dirname , 'public')))
// app.use(express.urlencoded({extended:true}));
// app.use(methodOverride('_method'))
// app.use(express.static(path.join(__dirname, "..", "client")));
app.use(express.json());






const SCOPE = "https://www.googleapis.com/auth/drive";
const upload = multer({ storage: multer.memoryStorage() }); // In-memory storage for Multer

// Google Drive Folder ID where files will be stored
const FOLDER_ID = "1MNudKLpqu0TG9lbNzkoHpkFKslSiEbx1"; // Replace with your folder ID

// Encryption Configuration
const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
const IV_LENGTH = 16; // AES block size (128 bits)

// Helper: Authorize Google Drive API
async function authorize() {
  const jwtClient = new google.auth.JWT(
    apikeys.client_email,
    null,
    apikeys.private_key,
    SCOPE
  );

  await jwtClient.authorize();
  return jwtClient;
}

// Helper: Encrypt File Buffer
function encrypt(buffer) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return { iv: iv.toString("hex"), content: encrypted.toString("hex") };
}

// Helper: Decrypt File Buffer
function decrypt(encryptedData) {
  const iv = Buffer.from(encryptedData.iv, "hex");
  const encryptedContent = Buffer.from(encryptedData.content, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", ENCRYPTION_KEY, iv);
  const decrypted = Buffer.concat([decipher.update(encryptedContent), decipher.final()]);
  return decrypted;
}

// Upload File to Google Drive
async function uploadToDrive(authClient, fileName, buffer) {
  const drive = google.drive({ version: "v3", auth: authClient });

  const fileMetadata = {
    name: fileName,
    parents: [FOLDER_ID], //Apna Google drive folder daloo
  };

  const { PassThrough } = require("stream");
  const stream = new PassThrough();
  stream.end(buffer);
  const media = {
    mimeType: "application/octet-stream",
    body: stream,
  };

  const response = await drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: "id",
  });

  return response.data.id; // Return the Google Drive file ID
}

// Endpoint: Upload File
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).send("No file uploaded.");
    }

    // Check if the uploaded file is a ZIP file
    const fileExtension = path.extname(file.originalname).toLowerCase();
    if (fileExtension !== ".zip") {
      return res.status(400).send("Only ZIP files are allowed.");
    }

    // Encrypt the file buffer
    const encryptedData = encrypt(file.buffer);

    // Generate a six-digit code
    const sixDigitCode = Math.floor(100000 + Math.random() * 900000).toString();
    const tempDir = os.tmpdir(); // Get the OS's temporary directory
    const encryptedFilePath = path.join(tempDir, `${sixDigitCode}.json`);

    // Save the encrypted file as a JSON in a temporary location
    // const encryptedFilePath = `/tmp/${sixDigitCode}.json`;
    fs.writeFileSync(encryptedFilePath, JSON.stringify(encryptedData));

    // Upload the encrypted file to Google Drive
    const authClient = await authorize();
    await uploadToDrive(authClient, `${sixDigitCode}.zip`, encryptedFilePath);

    // Clean up temporary file
    fs.unlinkSync(encryptedFilePath);

    res.status(200).send({
      message: "File uploaded successfully!",
      code: sixDigitCode,
    });
  } catch (error) {
    console.error("Upload Error:", error);
    res.status(500).send("An error occurred while uploading the file.");
  }
});

// Endpoint: Download File
app.get("/download/:code", async (req, res) => {
  try {
    const { code } = req.params;
    const authClient = await authorize();
    const drive = google.drive({ version: "v3", auth: authClient });

    // Search for the file in Google Drive
    const fileName = `${code}.zip`;
    const response = await drive.files.list({
      q: `'${FOLDER_ID}' in parents and name='${fileName}'`,
      fields: "files(id, name)",
    });

    if (response.data.files.length === 0) {
      return res.status(404).send("File not found.");
    }

    const fileId = response.data.files[0].id;

    // Ensure the temporary directory exists
    const tempDir = os.tmpdir(); // Get the OS's temporary directory
    const filePath = path.join(tempDir, fileName);

    // Create the temporary directory if it doesn't exist
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Download the file from Google Drive
    const dest = fs.createWriteStream(filePath);
    await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" },
      (err, res) => {
        if (err) {
          console.error("Download Error:", err);
          return;
        }
        res.data.pipe(dest);
      }
    );

    // Wait for the file to download
    dest.on("finish", () => {
      const encryptedData = JSON.parse(fs.readFileSync(filePath, "utf-8")); // Read as JSON
      const decryptedData = decrypt(encryptedData);


      // Send the decrypted file to the user
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
      res.send(decryptedData);

      // Clean up temporary file
      fs.unlinkSync(filePath);
    });
  } catch (error) {
    console.error("Download Error:", error);
    res.status(500).send("An error occurred while downloading the file.");
  }
});





// Start the server
const port=process.env.PORT || 8080;
app.listen(port , ()=>{
    console.log("Server running on http://localhost:8080")
})
