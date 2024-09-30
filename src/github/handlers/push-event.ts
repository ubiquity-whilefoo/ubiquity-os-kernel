import { Validator } from "@cfworker/json-schema";
import { ValueErrorType } from "@sinclair/typebox/value";
import { ValueError } from "typebox-validators";
import YAML, { LineCounter, Node, YAMLError } from "yaml";
import { GitHubContext } from "../github-context";
import { PluginConfiguration } from "../types/plugin-configuration";
import { stateValidationSchema } from "../types/state-validation-payload";
import { CONFIG_FULL_PATH, getConfigurationFromRepo } from "../utils/config";
import { getManifest } from "../utils/plugins";

function constructErrorBody(
  errors: Iterable<ValueError> | (YAML.YAMLError | ValueError)[],
  rawData: string | null,
  repository: GitHubContext<"push">["payload"]["repository"],
  after: string
) {
  const body = [];
  if (errors) {
    for (const error of errors) {
      body.push("> [!CAUTION]\n");
      if (error instanceof YAMLError) {
        body.push(`> https://github.com/${repository.owner?.login}/${repository.name}/blob/${after}/${CONFIG_FULL_PATH}#L${error.linePos?.[0].line || 0}`);
      } else if (rawData) {
        const lineCounter = new LineCounter();
        const doc = YAML.parseDocument(rawData, { lineCounter });
        const path = error.path.split("/").filter((o) => o);
        if (error.type === ValueErrorType.ObjectRequiredProperty) {
          path.splice(path.length - 1, 1);
        }
        const node = doc.getIn(path, true) as Node;
        const linePosStart = lineCounter.linePos(node?.range?.[0] || 0);
        body.push(`> https://github.com/${repository.owner?.login}/${repository.name}/blob/${after}/${CONFIG_FULL_PATH}#L${linePosStart.line}`);
      }
      const message = [];
      if (error instanceof YAMLError) {
        message.push(error.message);
      } else {
        message.push(`path: ${error.path}\n`);
        message.push(`value: ${error.value}\n`);
        message.push(`message: ${error.message}`);
      }
      body.push(`\n> \`\`\`\n`);
      body.push(`> ${message.join("").replaceAll("\n", "\n> ")}`);
      body.push(`\n> \`\`\`\n\n`);
    }
  }
  return body;
}

async function createCommitComment(
  context: GitHubContext,
  { owner, repo, commitSha, userLogin }: { owner: string; repo: string; commitSha: string; userLogin?: string },
  body: string[]
) {
  const { octokit } = context;

  const comment = (
    await octokit.rest.repos.listCommentsForCommit({
      owner: owner,
      repo: repo,
      commit_sha: commitSha,
    })
  ).data
    .filter((o) => o.user?.type === "Bot")
    .pop();
  if (comment) {
    await octokit.rest.repos.updateCommitComment({
      owner: owner,
      repo: repo,
      commit_sha: commitSha,
      comment_id: comment.id,
      body: `${comment.body}\n${body.join("")}`,
    });
  } else {
    body.unshift(`@${userLogin} Configuration is invalid.\n`);
    await octokit.rest.repos.createCommitComment({
      owner: owner,
      repo: repo,
      commit_sha: commitSha,
      body: body.join(""),
    });
  }
}

async function checkPluginConfigurations(context: GitHubContext<"push">, config: PluginConfiguration, rawData: string | null) {
  const errors: (ValueError | YAML.YAMLError)[] = [];
  const doc = rawData ? YAML.parseDocument(rawData) : null;

  for (let i = 0; i < config.plugins.length; ++i) {
    const { uses } = config.plugins[i];
    for (let j = 0; j < uses.length; ++j) {
      const { plugin, with: args } = uses[j];
      const manifest = await getManifest(context, plugin);
      if (!manifest?.configuration) {
        errors.push({
          path: `plugins/${i}/uses/${j}`,
          message: `Failed to fetch the manifest configuration.`,
          value: plugin,
          type: 0,
          schema: stateValidationSchema,
        });
      } else {
        const validator = new Validator(manifest.configuration, "7", false);
        const result = validator.validate(args);

        if (!result.valid) {
          for (const error of result.errors) {
            const path = error.instanceLocation.replace("#", `plugins/${i}/uses/${j}/with`);
            const value = doc?.getIn(path.split("/").filter((o) => o));
            errors.push({
              path,
              message: error.error,
              value,
              type: 0,
              schema: stateValidationSchema,
            });
          }
        }
      }
    }
  }
  return errors;
}

export default async function handlePushEvent(context: GitHubContext<"push">) {
  const { payload } = context;
  const { repository, commits, after } = payload;

  const didConfigurationFileChange = commits.some((commit) => commit.modified?.includes(CONFIG_FULL_PATH) || commit.added?.includes(CONFIG_FULL_PATH));

  if (!didConfigurationFileChange || !repository.owner) {
    return;
  }

  console.log("Configuration file changed, will run configuration checks.");

  const { config, errors: configurationErrors, rawData } = await getConfigurationFromRepo(context, repository.name, repository.owner.login);
  const errors: (ValueError | YAML.YAMLError)[] = [];
  if (!configurationErrors && config) {
    errors.push(...(await checkPluginConfigurations(context, config, rawData)));
  } else if (configurationErrors) {
    errors.push(...configurationErrors);
  }
  try {
    if (errors.length) {
      const body = [];
      body.push(...constructErrorBody(errors, rawData, repository, after));
      await createCommitComment(
        context,
        {
          owner: repository.owner.login,
          repo: repository.name,
          commitSha: after,
          userLogin: payload.sender?.login,
        },
        body
      );
    }
  } catch (e) {
    console.error("handlePushEventError", e);
  }
}
