import multer from "multer";
import os from "os";
import path from "path";
import fs from "fs";
import { promisify } from "util";
import xml2js from "xml2js";
import yauzl from "yauzl";

const fsPromises = fs.promises;

export const config = {
    api: {
        bodyParser: false, // Multer handles file parsing
    },
};

// Setup Multer for temporary file storage
const upload = multer({ dest: os.tmpdir() });

// Helper: Run middleware inside serverless function
function runMiddleware(req, res, fn) {
    return new Promise((resolve, reject) => {
        fn(req, res, (result) => {
            if (result instanceof Error) return reject(result);
            return resolve(result);
        });
    });
}

// Strip HTML tags from strings
function stripHtmlTags(htmlString) {
    if (!htmlString) return "";
    return htmlString.replace(/<[^>]*>?/gm, "").trim();
}

// Unzip IMSCC file
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
                        .then(() => zipfile.readEntry())
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
                                writeStream.on("finish", () =>
                                    zipfile.readEntry()
                                );
                                writeStream.on("error", reject);
                            });
                        })
                        .catch(reject);
                }
            });
            zipfile.on("end", () => resolve());
            zipfile.on("error", reject);
        });
    });
}

// Process XML file (quiz extraction)
async function processXmlFile(xmlFilePath) {
    const xmlString = await fsPromises.readFile(xmlFilePath, "utf-8");

    const parser = new xml2js.Parser({
        explicitArray: false,
        mergeAttrs: true,
        attrkey: "$",
        charkey: "#",
    });

    return new Promise((resolve, reject) => {
        parser.parseString(xmlString, (err, result) => {
            if (err) return reject(err);
            const mainContainer = result.questestinterop;
            if (!mainContainer) return resolve(null);

            let quizTitle;
            let items = [];

            if (mainContainer.assessment) {
                const assessment = mainContainer.assessment;
                quizTitle = assessment.title ?? "N/A";
                const section = assessment.section;
                if (section) {
                    items = Array.isArray(section.item)
                        ? section.item
                        : [section.item];
                }
            } else if (mainContainer.item) {
                quizTitle = "Single Item Quiz";
                items = Array.isArray(mainContainer.item)
                    ? mainContainer.item
                    : [mainContainer.item];
            } else {
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
                    correctAnswer: "N/A",
                    score: "N/A",
                }; // detect Multiple Choice

                if (item.presentation?.response_lid?.render_choice) {
                    question.responseType = "Multiple Choice";
                    const choices = Array.isArray(
                        item.presentation.response_lid.render_choice
                            .response_label
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
                            (cond) =>
                                cond.setvar &&
                                cond.setvar.$?.varname === "SCORE"
                        );

                    if (correctResponse) {
                        const correctIdent =
                            correctResponse.conditionvar?.varequal?.["#"] ?? "";
                        const correctChoice = question.options.find(
                            (opt) => opt.identifier === correctIdent
                        );
                        question.correctAnswer = {
                            id: correctIdent,
                            text: correctChoice?.text ?? "N/A",
                        }; // Extract and assign the score
                        question.score = correctResponse.setvar?.["#"] ?? "N/A";
                    }
                }

                return question;
            });

            resolve({ title: quizTitle, items: processedItems });
        });
    });
}
// Main API handler
export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Only POST allowed" });
    }

    try {
        await runMiddleware(req, res, upload.single("imsccFile"));

        if (!req.file) {
            return res.status(400).json({ error: "No file uploaded." });
        }

        const imsccFilePath = req.file.path;
        const tempDirPath = await fsPromises.mkdtemp(
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

        const resources = manifest.manifest.resources.resource;
        const quizFiles = Array.isArray(resources)
            ? resources.filter(
                  (r) => r.type === "imsqti_xmlv1p2/imscc_xmlv1p3/assessment"
              )
            : [resources].filter(
                  (r) => r?.type === "imsqti_xmlv1p2/imscc_xmlv1p3/assessment"
              );

        let allQuizData = [];
        for (const resource of quizFiles) {
            const relativePath = resource.file.href;
            const xmlFilePath = path.join(tempDirPath, relativePath);
            const quizData = await processXmlFile(xmlFilePath);
            if (quizData) allQuizData.push(quizData);
        }

        res.status(200).json({ subject: subjectName, quizzes: allQuizData });
    } catch (error) {
        console.error("Upload error:", error);
        res.status(500).json({ error: "Failed to process file" });
    }
}
