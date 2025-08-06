// api/index.js (formerly server.js)
const express = require("express");
const multer = require("multer");
const path = require("path");
const os = require("os");
const fs = require("fs");
const fsPromises = fs.promises;
const xml2js = require("xml2js");
const yauzl = require("yauzl");

const app = express();
// PORT is only for local development; Vercel assigns its own port.
const PORT = process.env.PORT || 3000;

// Setup Multer for temporary file storage.
// Vercel's serverless environment has a writable /tmp directory.
const upload = multer({ dest: os.tmpdir() });

// IMPORTANT: When deployed to Vercel, static files are served directly from the 'public' directory.
// This `app.use(express.static("public"));` line is primarily for local development
// if you run your server directly and want it to also serve the frontend.
// For Vercel, the 'public' directory is served automatically by default.

/**
 * Helper function to remove HTML tags from a string.
 * @param {string} htmlString The string containing HTML tags.
 * @returns {string} The string with HTML tags removed.
 */
function stripHtmlTags(htmlString) {
    if (!htmlString) return "";
    return htmlString.replace(/<[^>]*>?/gm, "").trim();
}

/**
 * Unzips an imscc file to a temporary directory.
 * @param {string} sourcePath The path to the .imscc file.
 * @param {string} destPath The path to the destination directory.
 * @returns {Promise<void>}
 */
function unzipFile(sourcePath, destPath) {
    return new Promise((resolve, reject) => {
        yauzl.open(sourcePath, { lazyEntries: true }, (err, zipfile) => {
            if (err) return reject(err);

            zipfile.readEntry();
            zipfile.on("entry", (entry) => {
                const entryPath = path.join(destPath, entry.fileName);
                if (/\/$/.test(entry.fileName)) {
                    fsPromises
                        .mkdir(entryPath, { recursive: true })
                        .then(() => {
                            zipfile.readEntry();
                        })
                        .catch(reject);
                } else {
                    fsPromises
                        .mkdir(path.dirname(entryPath), { recursive: true })
                        .then(() => {
                            zipfile.openReadStream(entry, (err, readStream) => {
                                if (err) return reject(err);
                                const writeStream =
                                    fs.createWriteStream(entryPath);
                                readStream.pipe(writeStream);
                                writeStream.on("finish", () => {
                                    zipfile.readEntry();
                                });
                                writeStream.on("error", reject);
                            });
                        })
                        .catch(reject);
                }
            });
            zipfile.on("end", () => {
                resolve();
            });
            zipfile.on("error", reject);
        });
    });
}

/**
 * Reads, parses, and processes a single XML file.
 * @param {string} xmlFilePath - The full path to the XML file.
 * @returns {Promise<Object|null>} A promise that resolves to the structured quiz object or null on error.
 */
async function processXmlFile(xmlFilePath) {
    const xmlString = await fsPromises.readFile(xmlFilePath, "utf-8");

    const parser = new xml2js.Parser({
        explicitArray: false,
        mergeAttrs: true,
        attrkey: "$",
        charkey: "#",
        strict: false, // Be lenient with malformed XML/HTML
    });

    return new Promise((resolve, reject) => {
        parser.parseString(xmlString, (err, result) => {
            if (err) return reject(err);
            const mainContainer = result.questestinterop;
            if (!mainContainer) {
                console.error("Error: 'questestinterop' tag not found.");
                return resolve(null);
            }

            let quizTitle;
            let items = [];

            if (mainContainer.assessment) {
                const assessment = mainContainer.assessment;
                quizTitle = assessment.title ?? "N/A (Title not found)";
                const section = assessment.section;
                if (section) {
                    items = Array.isArray(section.item)
                        ? section.item
                        : [section.item];
                }
            } else if (mainContainer.item) {
                quizTitle = "Single Item Quiz (No Assessment Tag)";
                items = Array.isArray(mainContainer.item)
                    ? mainContainer.item
                    : [mainContainer.item];
            } else {
                console.error("No valid assessment or item structure found.");
                return resolve(null);
            }

            const processedItems = items.map((item) => {
                const question = {
                    itemIdentifier: item.ident ?? "N/A",
                    questionText:
                        stripHtmlTags(
                            item.presentation?.material?.mattext?.["#"]
                        ) ?? "N/A",
                    responseType: "N/A",
                    options: [],
                    correctAnswer: { id: "N/A", text: "N/A" }, // Changed to an object to hold id and text
                    score: "N/A",
                };

                let score = "N/A";
                const qtimetadatafields = Array.isArray(
                    item.itemmetadata?.qtimetadata?.qtimetadatafield
                )
                    ? item.itemmetadata.qtimetadata.qtimetadatafield
                    : [item.itemmetadata?.qtimetadata?.qtimetadatafield].filter(
                          Boolean
                      );

                const weightField = qtimetadatafields.find(
                    (field) => field?.fieldlabel === "cc_weighting"
                );
                if (weightField) {
                    score = weightField.fieldentry ?? "N/A";
                } else {
                    const resprocessing = item.resprocessing;
                    if (resprocessing && resprocessing.respcondition) {
                        const respcondition = Array.isArray(
                            resprocessing.respcondition
                        )
                            ? resprocessing.respcondition[0]
                            : resprocessing.respcondition;
                        if (respcondition?.setvar) {
                            score = respcondition.setvar.val ?? "N/A";
                        }
                    }
                }
                question.score = score;

                const profileField = qtimetadatafields.find(
                    (f) => f.fieldlabel === "cc_profile"
                );
                const questionProfileType = profileField
                    ? profileField.fieldentry
                    : "unknown";

                if (questionProfileType === "cc.multiple_choice.v0p1") {
                    question.responseType = "Multiple Choice";
                    const choices = Array.isArray(
                        item.presentation?.response_lid?.render_choice
                            ?.response_label
                    )
                        ? item.presentation.response_lid.render_choice
                              .response_label
                        : [
                              item.presentation.response_lid.render_choice
                                  .response_label,
                          ];

                    choices.forEach((choice) => {
                        question.options.push({
                            identifier: choice.ident ?? "N/A",
                            text:
                                stripHtmlTags(
                                    choice.material?.mattext?.["#"]
                                ) ?? "N/A",
                        });
                    });

                    const correctResponse =
                        item.resprocessing?.respcondition?.find(
                            (cond) => cond.setvar
                        );
                    if (correctResponse) {
                        const correctIdent = (
                            correctResponse.conditionvar?.varequal?.["#"] ?? ""
                        ).trim();
                        const correctChoice = question.options.find(
                            (option) => option.identifier === correctIdent
                        );
                        question.correctAnswer = {
                            id: correctIdent,
                            text: correctChoice?.text ?? "N/A",
                        };
                    } else {
                        question.correctAnswer = { id: "N/A", text: "N/A" };
                    }
                } else if (questionProfileType === "cc.fib.v0p1") {
                    question.responseType = "Fill-in-the-Blank";
                    question.correctAnswer =
                        item.resprocessing?.respcondition?.[0]?.conditionvar
                            ?.varequal?.["#"] ?? "N/A";
                } else {
                    const isEssay = Array.isArray(profileField)
                        ? profileField.find(
                              (f) =>
                                  f.fieldlabel === "cc_profile" &&
                                  f.fieldentry === "cc.essay.v0p1"
                          )
                        : profileField?.fieldlabel === "cc_profile" &&
                          profileField?.fieldentry === "cc.essay.v0p1";
                    if (isEssay) {
                        question.responseType = "Essay";
                        question.correctAnswer = "Manual scoring required.";
                        question.score = "Manual grading";
                    } else {
                        question.responseType = "Unknown";
                    }
                }
                return question;
            });
            const quizData = { title: quizTitle, items: processedItems };
            resolve(quizData);
        });
    });
}

// Define the POST /api/upload endpoint
// This route will now be served by Vercel from the /api path.
app.post("/api/upload", upload.single("imsccFile"), async (req, res) => {
    if (!req.file) {
        return res.status(400).send("No file uploaded.");
    }

    const imsccFilePath = req.file.path;
    let tempDirPath;

    try {
        tempDirPath = await fsPromises.mkdtemp(
            path.join(os.tmpdir(), "imscc-")
        );
        await unzipFile(imsccFilePath, tempDirPath);

        const manifestFilePath = path.join(tempDirPath, "imsmanifest.xml");
        const manifestXml = await fsPromises.readFile(
            manifestFilePath,
            "utf-8"
        );
        const parser = new xml2js.Parser({
            explicitArray: false,
            mergeAttrs: true,
            attrkey: "$",
            charkey: "#",
            strict: false,
        });
        const manifest = await new Promise((resolve, reject) => {
            parser.parseString(manifestXml, (err, result) => {
                if (err) return reject(err);
                resolve(result);
            });
        });

        const subjectName =
            manifest.manifest?.metadata?.["lomm:lom"]?.["lomm:general"]?.[
                "lomm:title"
            ]?.["lomm:string"]?.["#"] ?? "N/A";

        const resources = Array.isArray(manifest.manifest.resources.resource)
            ? manifest.manifest.resources.resource
            : [manifest.manifest.resources.resource].filter(Boolean);

        const quizFiles = resources.filter(
            (r) => r.type === "imsqti_xmlv1p2/imscc_xmlv1p3/assessment"
        );

        let allQuizData = [];
        for (const resource of quizFiles) {
            const files = Array.isArray(resource.file)
                ? resource.file
                : [resource.file].filter(Boolean);
            const relativePath = files[0]?.href;

            if (relativePath) {
                const xmlFilePath = path.join(tempDirPath, relativePath);
                const quizData = await processXmlFile(xmlFilePath);
                if (quizData) {
                    allQuizData.push(quizData);
                }
            }
        }

        res.json({ subject: subjectName, quizzes: allQuizData });
    } catch (error) {
        console.error("Error processing file:", error);
        res.status(500).send("Error processing the file.");
    } finally {
        if (req.file) {
            await fsPromises
                .unlink(imsccFilePath)
                .catch((e) => console.error(`Error deleting temp file: ${e}`));
        }
        if (tempDirPath) {
            await fsPromises
                .rm(tempDirPath, { recursive: true, force: true })
                .catch((e) => console.error(`Error deleting temp dir: ${e}`));
        }
    }
});

// This app.listen is only for local development and will be ignored by Vercel.
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

// This line is crucial for Vercel to treat this file as a serverless function.
// It tells Vercel to export your Express 'app' instance.
module.exports = app;
