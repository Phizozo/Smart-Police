# AWS setup for Citizen camera sign-in

## Current status

This guide and template prepare the AWS resources. They do **not** enable face
sign-in in the portal. No AWS resources have been created by the agent, no faces
have been enrolled, and existing password/passkey sign-in remains unchanged.
The application integration and live-device verification follow after setup.

## What you will create

- A dedicated Amazon Rekognition face collection.
- A Cognito **identity pool**, used only to issue short-lived credentials for
  streaming a camera liveness check. This does not migrate portal users or
  replace the portal's existing authentication.
- A browser role allowed only to start liveness streaming.
- A separate backend IAM user allowed to create/read liveness sessions and
  enrol, search and remove faces in this collection.

The template does not create access keys or include any passwords or secrets.
It does not create an S3 archive. The collection contains face representations;
AWS also processes the live-camera video.

## 1. Create the resources in your AWS account

1. Sign in to the [AWS console](https://console.aws.amazon.com/).
2. Choose a region supported by Face Liveness: `eu-west-1` (Ireland),
   `us-east-1` (N. Virginia), `us-west-2` (Oregon), `ap-south-1` (Mumbai),
   or `ap-northeast-1` (Tokyo). Review biometric data location and consent
   requirements before choosing. AWS's current supported-region list is linked below.
3. Open **CloudFormation → Create stack → With new resources**.
4. Select **Upload a template file** and upload the project file
   `docs/aws-face-signin-stack.json`.
5. Name the stack `smartpolice-face-signin`, review the resources and IAM
   permissions, acknowledge IAM resource creation, and create the stack.
6. Wait for **CREATE_COMPLETE**. If AWS rejects the template or permissions,
   stop and share the error text without secrets.
7. Open the stack's **Outputs** tab. Keep these non-secret values:
   `AWSRegion`, `FaceCollectionId`, `LivenessIdentityPoolId` and
   `BackendIAMUserName`.

Rekognition processing and face storage can incur AWS charges. Configure AWS
Budgets/alerts and review pricing before enabling use by Citizens. No region is
chosen automatically by the application.

## 2. Create a restricted backend key

1. Open **IAM → Users** and select the user named in `BackendIAMUserName`.
2. Open **Security credentials → Create access key**. Select the use case for
   an application running outside AWS.
3. Put the access key ID and secret access key in the project's **secure
   credential prompt** as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
4. Never paste either key in chat, source code, screenshots, or a shared document.
   Do not create or use root-account access keys. No administrator-access key
   is needed.

The region, collection ID and identity pool ID will be collected separately as
non-secret configuration.

## Security and enrolment requirements

The eventual application integration must obtain each Citizen's explicit consent,
bind enrolment to their authenticated account, and never reuse document-review
photos as biometric enrolment. Login must verify both liveness and a matching
enrolled face on the server, with short-lived, session-bound, single-use
challenges. A browser success callback is not sufficient proof.

Suspended accounts must remain blocked, and password changes or suspension must
invalidate outstanding challenges. Existing two-step requirements must not be
bypassed. Provide a way to remove face enrolment and a non-biometric fallback.
Thresholds need evaluation on real supported devices before public rollout.

## Cleanup

Remove manually created access keys before deleting the stack, otherwise IAM
user deletion may fail. The face collection is intentionally **retained** when
the stack is deleted or replaced to prevent accidental loss of enrolment data.
Retention is not automatic biometric-data erasure: when retiring the service,
explicitly delete the retained collection through Rekognition after following
your consent and retention policy.

## Official references

- [Face Liveness supported regions and FAQ](https://docs.aws.amazon.com/rekognition/latest/dg/face-liveness-faq.html)
- [Face Liveness backend flow](https://docs.aws.amazon.com/rekognition/latest/dg/face-liveness-programming-api.html)
- [Browser camera component and IAM setup](https://ui.docs.amplify.aws/react/connected-components/liveness)
- [CloudFormation face collection](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-rekognition-collection.html)
- [Rekognition pricing](https://aws.amazon.com/rekognition/pricing/)
