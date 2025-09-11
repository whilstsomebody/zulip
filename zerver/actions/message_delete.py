from collections import defaultdict
from collections.abc import Iterable
from typing import TypedDict

from django.db.models import Q
from pydantic import BaseModel

from zerver.lib import retention
from zerver.lib.message import event_recipient_ids_for_action_on_messages
from zerver.lib.retention import move_messages_to_archive
from zerver.lib.streams import get_public_streams_queryset
from zerver.models import Message, Realm, Stream, UserProfile
from zerver.models.recipients import Recipient
from zerver.tornado.django_api import send_event_on_commit


class DeleteMessagesEvent(TypedDict, total=False):
    type: str
    message_ids: list[int]
    message_type: str
    topic: str
    stream_id: int


class DeactivateUserActions(BaseModel):
    delete_public_stream_messages: bool = False
    delete_private_stream_messages: bool = False
    delete_direct_messages: bool = False


def check_update_first_message_id(
    realm: Realm, stream: Stream, message_ids: list[int], users_to_notify: Iterable[int]
) -> None:
    # This will not update the `first_message_id` of streams where the
    # first message was deleted prior to the implementation of this function.
    assert stream.recipient_id is not None
    if stream.first_message_id not in message_ids:
        return
    current_first_message_id = (
        Message.objects.filter(realm_id=realm.id, recipient_id=stream.recipient_id)
        .values_list("id", flat=True)
        .order_by("id")
        .first()
    )

    stream.first_message_id = current_first_message_id
    stream.save(update_fields=["first_message_id"])

    stream_event = dict(
        type="stream",
        op="update",
        property="first_message_id",
        value=stream.first_message_id,
        stream_id=stream.id,
        name=stream.name,
    )
    send_event_on_commit(realm, stream_event, users_to_notify)


def _process_grouped_messages_deletion(
    realm: Realm,
    grouped_messages: list[Message],
    *,
    stream: Stream | None,
    topic: str | None,
    acting_user: UserProfile | None,
) -> None:
    """
    Helper for do_delete_messages. Should not be called directly otherwise.
    """

    message_ids = [message.id for message in grouped_messages]
    if not message_ids:
        return  # nocoverage

    event: DeleteMessagesEvent = {
        "type": "delete_message",
        "message_ids": sorted(message_ids),
    }
    if stream is None:
        assert topic is None
        message_type = "private"
        archiving_chunk_size = retention.MESSAGE_BATCH_SIZE
    else:
        assert topic is not None
        message_type = "stream"
        event["stream_id"] = stream.id
        event["topic"] = topic
        archiving_chunk_size = retention.STREAM_MESSAGE_BATCH_SIZE
    event["message_type"] = message_type

    # We exclude long-term idle users, since they by definition have no active clients.
    users_to_notify = event_recipient_ids_for_action_on_messages(
        grouped_messages,
        channel=stream if message_type == "stream" else None,
    )

    if acting_user is not None:
        # Always send event to the user who deleted the message.
        users_to_notify.add(acting_user.id)

    move_messages_to_archive(message_ids, realm=realm, chunk_size=archiving_chunk_size)
    if stream is not None:
        check_update_first_message_id(realm, stream, message_ids, users_to_notify)

    send_event_on_commit(realm, event, users_to_notify)


def do_delete_messages(
    realm: Realm,
    messages: Iterable[Message],
    *,
    acting_user: UserProfile | None,
    streams_by_recipient_id: dict[int, Stream] | None = None,
) -> None:
    """1:1 Direct messages must be grouped to a single convesration by
    the caller, since this logic does not know how to handle multiple
    senders sharing a single Recipient object.

    When the Recipient.PERSONAL is no longer a case to consider, this
    restriction can be deleted.
    Args:
        streams_by_recipient_id: Optional dict mapping recipient_id to Stream objects
                                to avoid redundant database queries.
    """
    private_messages_by_recipient: defaultdict[int, list[Message]] = defaultdict(list)
    stream_messages_by_recipient_and_topic: defaultdict[tuple[int, str], list[Message]] = (
        defaultdict(list)
    )
    streams_by_recipient_id = streams_by_recipient_id or {}
    for message in messages:
        if message.is_channel_message:
            recipient_id = message.recipient_id
            # topics are case-insensitive.
            topic_name = message.topic_name().lower()
            stream_messages_by_recipient_and_topic[(recipient_id, topic_name)].append(message)
        else:
            recipient_id = message.recipient.id
            private_messages_by_recipient[recipient_id].append(message)

    for recipient_id, grouped_messages in sorted(private_messages_by_recipient.items()):
        _process_grouped_messages_deletion(
            realm, grouped_messages, stream=None, topic=None, acting_user=acting_user
        )

    for (
        (recipient_id, topic_name),
        grouped_messages,
    ) in sorted(stream_messages_by_recipient_and_topic.items()):
        if recipient_id not in streams_by_recipient_id:
            streams_by_recipient_id[recipient_id] = Stream.objects.get(recipient_id=recipient_id)
        stream = streams_by_recipient_id[recipient_id]
        _process_grouped_messages_deletion(
            realm, grouped_messages, stream=stream, topic=topic_name, acting_user=acting_user
        )


def do_delete_messages_by_sender(user: UserProfile) -> None:
    message_ids = list(
        # Uses index: zerver_message_realm_sender_recipient (prefix)
        Message.objects.filter(realm_id=user.realm_id, sender=user)
        .values_list("id", flat=True)
        .order_by("id")
    )
    if message_ids:
        move_messages_to_archive(message_ids, chunk_size=retention.STREAM_MESSAGE_BATCH_SIZE)


def delete_deactivated_user_messages(
    realm: Realm,
    user_profile: UserProfile,
    deactivate_user_actions: DeactivateUserActions,
    acting_user: UserProfile | None,
) -> None:
    delete_public_stream_messages = deactivate_user_actions.delete_public_stream_messages
    delete_private_stream_messages = deactivate_user_actions.delete_private_stream_messages
    delete_direct_messages = deactivate_user_actions.delete_direct_messages

    if not (
        delete_public_stream_messages or delete_private_stream_messages or delete_direct_messages
    ):
        return

    message_filter_query = Q()
    message_exclude_query = Q()

    if delete_direct_messages:
        message_filter_query |= Q(recipient__type=Recipient.DIRECT_MESSAGE_GROUP)

    public_stream_ids = get_public_streams_queryset(realm).values_list("id", flat=True)
    if delete_public_stream_messages and delete_private_stream_messages:
        message_filter_query |= Q(recipient__type=Recipient.STREAM)
    elif delete_public_stream_messages:
        message_filter_query |= Q(
            recipient__type=Recipient.STREAM,
            recipient__type_id__in=list(public_stream_ids),
        )
    elif delete_private_stream_messages:
        message_filter_query |= Q(recipient__type=Recipient.STREAM)
        message_exclude_query |= Q(
            recipient__type=Recipient.STREAM,
            recipient__type_id__in=list(public_stream_ids),
        )

    messages = list(
        Message.objects.filter(sender=user_profile, realm_id=user_profile.realm_id)
        .filter(message_filter_query)
        .exclude(message_exclude_query)
        .select_related("recipient")
    )
    do_delete_messages(user_profile.realm, messages, acting_user=acting_user)

    # 1:1 DMs need to be handled separately as we need to group them by conversation
    if delete_direct_messages:
        direct_messages = list(
            Message.objects.filter(
                sender=user_profile,
                realm_id=user_profile.realm_id,
                recipient__type=Recipient.PERSONAL,
            ).select_related("recipient")
        )

        personal_messages_by_recipient_dict: defaultdict[int, list[Message]] = defaultdict(list)
        for message in direct_messages:
            recipient_user_id = message.recipient.type_id
            personal_messages_by_recipient_dict[recipient_user_id].append(message)

        for conversation_messages in personal_messages_by_recipient_dict.values():
            do_delete_messages(user_profile.realm, conversation_messages, acting_user=acting_user)
