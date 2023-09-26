const { getInput, setFailed } = require( '@actions/core' );
const { getOctokit } = require( '@actions/github' );
const debug = require( '../../utils/debug' );
const getLabels = require( '../../utils/get-labels' );

/* global GitHub, WebhookPayloadIssue */

/**
 * Check for Priority labels on an issue.
 * It could be existing labels,
 * or it could be that it's being added as part of the event that triggers this action.
 *
 * @param {GitHub} octokit    - Initialized Octokit REST client.
 * @param {string} owner      - Repository owner.
 * @param {string} repo       - Repository name.
 * @param {string} number     - Issue number.
 * @param {string} action     - Action that triggered the event ('opened', 'reopened', 'labeled').
 * @param {object} eventLabel - Label that was added to the issue.
 * @returns {Promise<Array>} Promise resolving to an array of Priority labels.
 */
async function hasPriorityLabels( octokit, owner, repo, number, action, eventLabel ) {
	const labels = await getLabels( octokit, owner, repo, number );
	if ( 'labeled' === action && eventLabel.name && eventLabel.name.match( /^\[Pri\].*$/ ) ) {
		labels.push( eventLabel.name );
	}

	return labels.filter( label => label.match( /^\[Pri\].*$/ ) );
}

/**
 * Check for a "[Status] Escalated" label showing that it was already escalated.
 * It could be an existing label,
 * or it could be that it's being added as part of the event that triggers this action.
 *
 * @param {GitHub} octokit    - Initialized Octokit REST client.
 * @param {string} owner      - Repository owner.
 * @param {string} repo       - Repository name.
 * @param {string} number     - Issue number.
 * @param {string} action     - Action that triggered the event ('opened', 'reopened', 'labeled').
 * @param {object} eventLabel - Label that was added to the issue.
 * @returns {Promise<boolean>} Promise resolving to boolean.
 */
async function hasEscalatedLabel( octokit, owner, repo, number, action, eventLabel ) {
	// Check for an exisiting label first.
	const labels = await getLabels( octokit, owner, repo, number );
	if (
		labels.includes( '[Status] Escalated' ) ||
		labels.includes( '[Status] Escalated to Kitkat' )
	) {
		return true;
	}

	// If the issue is being labeled, check if the label is "[Status] Escalated".
	// No need to check for "[Status] Escalated to Kitkat" here, it's a legacy label.
	if (
		'labeled' === action &&
		eventLabel.name &&
		eventLabel.name.match( /^\[Status\] Escalated.*$/ )
	) {
		return true;
	}
}

/**
 * Ensure the issue is a bug, by looking for a "[Type] Bug" label.
 * It could be an existing label,
 * or it could be that it's being added as part of the event that triggers this action.
 *
 * @param {GitHub} octokit    - Initialized Octokit REST client.
 * @param {string} owner      - Repository owner.
 * @param {string} repo       - Repository name.
 * @param {string} number     - Issue number.
 * @param {string} action     - Action that triggered the event ('opened', 'reopened', 'labeled').
 * @param {object} eventLabel - Label that was added to the issue.
 * @returns {Promise<boolean>} Promise resolving to boolean.
 */
async function isBug( octokit, owner, repo, number, action, eventLabel ) {
	// If the issue has a "[Type] Bug" label, it's a bug.
	const labels = await getLabels( octokit, owner, repo, number );
	if ( labels.includes( '[Type] Bug' ) ) {
		return true;
	}

	// Next, check if the current event was a [Type] Bug label being added.
	if ( 'labeled' === action && eventLabel.name && '[Type] Bug' === eventLabel.name ) {
		return true;
	}
}

/**
 * Find list of plugins impacted by issue, based off issue contents.
 *
 * @param {string} body - The issue content.
 * @returns {Array} Plugins concerned by issue.
 */
function findPlugins( body ) {
	const regex = /###\sImpacted\splugin\n\n([a-zA-Z ,]*)\n\n/gm;

	const match = regex.exec( body );
	if ( match ) {
		const [ , plugins ] = match;
		return plugins.split( ', ' ).filter( v => v.trim() !== '' );
	}

	debug( `triage-issues: No plugin indicators found.` );
	return [];
}

/**
 * Find platform info, based off issue contents.
 *
 * @param {string} body - The issue content.
 * @returns {Array} Platforms impacted by issue.
 */
function findPlatforms( body ) {
	const regex = /###\sPlatform\s\(Simple\sand\/or Atomic\)\n\n([a-zA-Z ,-]*)\n\n/gm;

	const match = regex.exec( body );
	if ( match ) {
		const [ , platforms ] = match;
		return platforms
			.split( ', ' )
			.filter( platform => platform !== 'Self-hosted' && platform.trim() !== '' );
	}

	debug( `triage-issues: no platform indicators found.` );
	return [];
}

/**
 * Figure out the priority of the issue, based off issue contents.
 * Logic follows this priority matrix: pciE2j-oG-p2
 *
 * @param {string} body - The issue content.
 * @returns {string} Priority of issue.
 */
function findPriority( body ) {
	// Look for priority indicators in body.
	const priorityRegex =
		/###\sImpact\n\n(?<impact>.*)\n\n###\sAvailable\sworkarounds\?\n\n(?<blocking>.*)\n/gm;
	let match;
	while ( ( match = priorityRegex.exec( body ) ) ) {
		const [ , impact = '', blocking = '' ] = match;

		debug(
			`triage-issues: Reported priority indicators for issue: "${ impact }" / "${ blocking }"`
		);

		if ( blocking === 'No and the platform is unusable' ) {
			return impact === 'One' ? 'High' : 'BLOCKER';
		} else if ( blocking === 'No but the platform is still usable' ) {
			return 'High';
		} else if ( blocking === 'Yes, difficult to implement' ) {
			return impact === 'All' ? 'High' : 'Normal';
		} else if ( blocking !== '' && blocking !== '_No response_' ) {
			return impact === 'All' || impact === 'Most (> 50%)' ? 'Normal' : 'Low';
		}
		return 'TBD';
	}

	debug( `triage-issues: No priority indicators found.` );
	return 'TBD';
}
/**
 * Update a single select field of an issue on the project board.
 *
 * @param {GitHub} octokit   - Initialized Octokit REST client with project permissions.
 * @param {string} fieldId   - Node id of the filed to be updated.
 * @param {string} itemId    - Node id of the item (issue) to be updated.
 * @param {string} projectId - Node id of the project.
 * @param {string} optionId  - Action that triggered the event ('opened', 'reopened', 'labeled').
 * @returns {Promise<boolean>} Promise resolving to boolean.
 */
async function updateProjectField( octokit, fieldId, itemId, projectId, optionId) {

	debug(
		`update-project-field: itemId: ${ itemId }`
	);
	// TODO: Get the itemId programmatically.
	const projectItemDetails = await octokit.graphql(
		`mutation ( $input: UpdateProjectV2ItemFieldValueInput! ) {
			set_status: updateProjectV2ItemFieldValue( input: $input ) {
				projectV2Item {
					id
				}
			}
		}`,
		{
			input: {
				fieldId: fieldId,
				itemId: itemId,
				projectId: projectId,
				value: {
					singleSelectOptionId: optionId,
				},
			},
		}
	);

	// TODO: Check if the field was updated and return true.
	return true;
}

/**
 * Gets the item node id, which is needed to updated project fields for an issue.
 *
 * @param {GitHub} octokit    - Initialized Octokit REST client with project permissions.
 * @param {string} nodeId     - Node id of the issue to be updated.
 * @returns {Promise<string>} Promise resolving to a string.
 */
async function getItemNodeId( octokit, nodeId) {
	// TODO: Find a cleaner way to do this.
	const issueProjectDetails = await octokit.graphql(
		`query getIssueProjectDetails($id: ID!){
			node(id: $id) {
				... on Issue {
					projectItems(first: 10) {
						... on ProjectV2ItemConnection {
							nodes {
								content {
									... on Issue {
										id
										projectItems(first: 10) {
											nodes {
												id
											}
										}
									}
								}
							}
						}
					}
				}
			}
		}`,
		{
			id: nodeId
		}
	);

	// TODO: Figure out how to access itemNodeId

	debug(
		`get-issue-project-details: projectItemId: ${ issueProjectDetails }`
	);
	debug(
		`get-issue-project-details: projectItemId2: ${ issueProjectDetails.node?.projectItems }`
	);

	return 'PVTI_lADOCGvWfc4AUwHEzgI4tDo';
}

/**
 * Get Information about a project board.
 *
 * @param {GitHub} octokit          - Initialized Octokit REST client with project permissions.
 * @param {string} projectBoardLink - The link to the project board.
 * @returns {Promise<Object>} - Project board information.
 */
async function getProjectDetails( octokit, projectBoardLink ) {

	const projectRegex = /^(?:https:\/\/)?github\.com\/(?<ownerType>orgs|users)\/(?<ownerName>[^/]+)\/projects\/(?<projectNumber>\d+)/;
	const matches = projectBoardLink.match( projectRegex );
	if ( ! matches ) {
		debug( `triage-issues: Invalid project board link provided. Cannot triage to a board` );
		return {};
	}
	const {
		groups: { ownerType, ownerName, projectNumber },
	} = matches;

	const projectInfo = {
		ownerType: ownerType === 'orgs' ? 'organization' : 'user', // GitHub API requests require 'organization' or 'user'.
		ownerName,
		projectNumber: parseInt( projectNumber, 10 ),
	};

	debug(
		`project-info: Owner type: ${ projectInfo.ownerType }, Owner name: ${ projectInfo.ownerName }, Project number: ${ projectInfo.projectNumber }`
	);

	// Use the GraphQL API to request the project's details.
	// TODO: Swap out organization, also update method name
	const projectDetails = await octokit.graphql(
		`query getProject($ownerName: String!, $projectNumber: Int!) {
			organization(login: $ownerName) {
				projectV2(number: $projectNumber) {
					id
					fields(first:20) {
						nodes {
							... on ProjectV2Field {
								id
								name
							}
							... on ProjectV2SingleSelectField {
								id
								name
								options {
									id
									name
								}
							}
						}
					}
				}
			}
		}`,
		{
			ownerName: projectInfo.ownerName,
			projectNumber: projectInfo.projectNumber,
		}
	);

	// Extract the project node ID.
	const projectNodeId = projectDetails.organization?.projectV2.id;
	if ( projectNodeId ) {
		projectInfo.projectNodeId = projectNodeId; // Project board node ID. String.
		debug(
			`project-details: Project node id is ${ projectNodeId }`
		);
	}

	debug(
		`project-details: Project fields are ${ projectDetails.organization.projectV2.fields }`
	);

	// Extract the id of the Priority field.
	const priorityField = projectDetails.organization?.projectV2.fields.nodes.find(
		field => field.name === 'Priority'
	);
	if ( priorityField ) {
		projectInfo.priority = priorityField; // Info about our priority column (id as well as possible values).
		debug(
			`priority-field: ${ priorityField } is a field in the project`
		);
	}

	return projectInfo;
}

/**
 * Automatically add labels to issues, and send Slack notifications.
 *
 * This task can send 2 different types of Slack notifications:
 * - If an issue is determined as High or Blocker priority,
 * - If no priority is determined.
 *
 * @param {WebhookPayloadIssue} payload - Issue event payload.
 * @param {GitHub}              octokit - Initialized Octokit REST client.
 */
async function triageIssues( payload, octokit ) {
	const { action, issue, label = {}, repository } = payload;
	const { number, body, state, node_id } = issue;
	const { owner, name, full_name } = repository;
	const ownerLogin = owner.login;

	// Get the project automation token, which has special permissions to update GitHub projects.
	// TODO: Have separate paths for regular token and project automation token.
	const projectToken = getInput( 'project_automation_token' );
	if ( ! projectToken ) {
		setFailed(
			`triage-issues: Input project_automation_token is required but missing. Aborting.`
		);
		return;
	}

	// Create a new Octokit instance using our the project token.
	// eslint-disable-next-line new-cap
	const projectOctokit = new getOctokit( projectToken );

	// Get the URL of the project board, which contains useful information about the project.
	const projectBoardLink = getInput( 'project_board' );
	if ( ! projectBoardLink ) {
		setFailed( 'triage-issues: No project board link provided. Cannot triage to a board.' );
		return;
	}

	const projectInfo = await getProjectDetails(projectOctokit, projectBoardLink)

	// Check if the issue is in the project (returns the project number)
	// TODO: Programmaticlally get the project number
	const isInProject = await projectOctokit.graphql(
		`query getProjectNumber($id: ID!, $number: Int!){
			node(id: $id) {
				... on Issue {
					projectV2(number: $number) {
						id
						number
					}
				}
			}
		}`,
		{
			id: node_id,
			number: 11
		}
	);
	const itemId = isInProject.node?.projectV2.id;

	debug(
		`is-in-project: Project node is ${ isInProject.node?.projectV2.id }`
	);
	debug(
		`is-in-project: Project number is ${ isInProject.node?.projectV2.number }`
	);

	const itemNodeId = await getItemNodeId(projectOctokit, node_id);

	debug(
		`priority-field: Item node id: ${ itemNodeId }`
	);

	// Prepare info about the priority field.
	// TODO: Change priority text based on label.
	const {
		priority: {
			id: priorityFieldId, // ID of the status field.
			options,
		},
	} = projectInfo;
	const priorityText = 'Low';

	debug(
		`priority-field: Priority node id: ${ priorityFieldId }, Node id: ${ node_id }, Project number: ${ projectNodeId }`
	);

	// Find the ID of the priority option that matches the priority label.
	const priorityOptionId = options.find( option => option.name === priorityText ).id;
	if ( ! priorityOptionId ) {
		debug(
			`priority-field: Priority ${ priorityText } does not exist as a column option in the project board.`
		);
		
	}

	const isUpdated = await updateProjectField(projectOctokit, priorityFieldId, itemNodeId, projectNodeId, priorityOptionId);

	debug( `Project has been updated: ${ isUpdated }` );

	// TODO: Find a way to check if it was successful.
	// const projectItemId = projectItemDetails.updateProjectV2ItemFieldValue.projectV2Item.id;
	// if ( ! projectItemId ) {
	// 	debug( `Triage: Failed to add PR to project board.` );
	// 	return '';
	// }

	// Find Priority.
	const priorityLabels = await hasPriorityLabels(
		octokit,
		ownerLogin,
		name,
		number,
		action,
		label
	);
	if ( priorityLabels.length > 0 ) {
		debug(
			`triage-issues: Issue #${ number } has the following priority labels: ${ priorityLabels.join(
				', '
			) }`
		);
	} else {
		debug( `triage-issues: Issue #${ number } has no existing priority labels.` );
	}

	debug( `triage-issues: Finding priority for issue #${ number } based off the issue contents.` );
	const priority = findPriority( body );
	debug( `triage-issues: Priority for issue #${ number } is ${ priority }` );

	const isBugIssue = await isBug( octokit, ownerLogin, name, number, action, label );

	// If this is a new issue, try to add labels.
	if ( action === 'opened' || action === 'reopened' ) {
		// Find impacted plugins, and add labels.
		const impactedPlugins = findPlugins( body );
		if ( impactedPlugins.length > 0 ) {
			debug( `triage-issues: Adding plugin labels to issue #${ number }` );

			const pluginLabels = impactedPlugins.map( plugin => `[Plugin] ${ plugin }` );

			await octokit.rest.issues.addLabels( {
				owner: ownerLogin,
				repo: name,
				issue_number: number,
				labels: pluginLabels,
			} );
		}

		// Find platform info, and add labels.
		const impactedPlatforms = findPlatforms( body );
		if ( impactedPlatforms.length > 0 ) {
			debug( `triage-issues: Adding platform labels to issue #${ number }` );

			const platformLabels = impactedPlatforms.map( platform => `[Platform] ${ platform }` );

			await octokit.rest.issues.addLabels( {
				owner: ownerLogin,
				repo: name,
				issue_number: number,
				labels: platformLabels,
			} );
		}

		// Add priority label to all bugs, if none already exists on the issue.
		if ( priorityLabels.length === 0 && isBugIssue ) {
			debug( `triage-issues: Adding [Pri] ${ priority } label to issue #${ number }` );

			await octokit.rest.issues.addLabels( {
				owner: ownerLogin,
				repo: name,
				issue_number: number,
				labels: [ `[Pri] ${ priority }` ],
			} );
		}
	}
}
module.exports = triageIssues;
